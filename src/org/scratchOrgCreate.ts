/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import { Duration } from '@salesforce/kit';
import { ensureString, getString } from '@salesforce/ts-types';
import { Messages } from '../messages';
import { Logger } from '../logger';
import { ConfigAggregator } from '../config/configAggregator';
import { SfProject } from '../sfProject';
import { GlobalInfo } from '../globalInfo';
import { Org } from './org';
import {
  authorizeScratchOrg,
  requestScratchOrgCreation,
  pollForScratchOrgInfo,
  deploySettings,
  resolveUrl,
} from './scratchOrgInfoApi';
import { ScratchOrgInfo } from './scratchOrgTypes';
import SettingsGenerator from './scratchOrgSettingsGenerator';
import { generateScratchOrgInfo, getScratchOrgInfoPayload } from './scratchOrgInfoGenerator';
import { AuthFields, AuthInfo } from './authInfo';
import { emit, emitPostOrgCreate } from './scratchOrgLifecycleEvents';
import { ScratchOrgCache } from './scratchOrgCache';
import { checkScratchOrgInfoForErrors } from './scratchOrgErrorCodes';

Messages.importMessagesDirectory(__dirname);
const messages = Messages.load('@salesforce/core', 'scratchOrgCreate', [
  'SourceStatusResetFailureError',
  'DurationDaysValidationMaxError',
  'DurationDaysValidationMinError',
  'RetryNotIntError',
  'WaitValidationMaxError',
  'DurationDaysNotIntError',
  'NoScratchOrgInfoError',
  'ScratchOrgDeletedError',
  'StillInProgressError',
  'action.StillInProgress',
]);

export const DEFAULT_STREAM_TIMEOUT_MINUTES = 6;

export interface ScratchOrgCreateResult {
  username?: string;
  scratchOrgInfo?: ScratchOrgInfo;
  authInfo?: AuthInfo;
  authFields?: AuthFields;
  warnings: string[];
}
export interface ScratchOrgCreateOptions {
  /** the environment hub org */
  hubOrg: Org;
  /** The connected app consumer key. */
  connectedAppConsumerKey?: string;
  /** duration of the scratch org (in days) (default:1, min:1, max:30) */
  durationDays?: number;
  /** create the scratch org with no namespace */
  nonamespace?: boolean;
  /** create the scratch org with no second-generation package ancestors */
  noancestors?: boolean;
  /** the streaming client socket timeout (in minutes) must be an instance of the Duration utility class (default:6) */
  wait?: Duration;
  /** number of scratch org auth retries after scratch org is successfully signed up (default:0, min:0, max:10) */
  retry?: number;
  /** target server instance API version */
  apiversion?: string;
  /** org definition in JSON format, stringified */
  definitionjson?: string;
  /** path to an org definition file */
  definitionfile?: string;
  /** overrides definitionjson */
  orgConfig?: Record<string, unknown>;
  /** OAuth client secret of personal connected app */
  clientSecret?: string;
  /** alias to set for the created org */
  alias?: string;
  /** after complete, set the org as the default */
  setDefault?: boolean;
}

const validateDuration = (durationDays: number): void => {
  const min = 1;
  const max = 30;
  if (Number.isInteger(durationDays)) {
    if (durationDays < min) {
      throw messages.createError('DurationDaysValidationMinError', [min, durationDays]);
    }
    if (durationDays > max) {
      throw messages.createError('DurationDaysValidationMaxError', [max, durationDays]);
    }
    return;
  }
  throw messages.createError('DurationDaysNotIntError');
};

const validateRetry = (retry: number): void => {
  if (!Number.isInteger(retry)) {
    throw messages.createError('RetryNotIntError');
  }
};

export const scratchOrgResume = async (jobId: string): Promise<ScratchOrgCreateResult> => {
  const [logger, cache] = await Promise.all([
    Logger.child('scratchOrgResume'),
    ScratchOrgCache.create(),
    emit({ stage: 'send request' }),
  ]);
  const { hubUsername, apiVersion, clientSecret, signupTargetLoginUrlConfig, definitionjson, alias, setDefault } =
    cache.get(jobId);
  const hubOrg = await Org.create({ aliasOrUsername: hubUsername });
  const soi = (await hubOrg.getConnection().sobject('ScratchOrgInfo').retrieve(jobId)) as unknown as ScratchOrgInfo;
  if (!soi || !soi.Id) {
    // 1. scratch org info does not exist in that dev hub
    cache.unset(jobId);
    await cache.write();
    throw messages.createError('NoScratchOrgInfoError');
  }
  if (['New', 'Creating'].includes(soi.Status)) {
    // 2. SOI exists, still isn't finished.  Stays in cache for future attempts
    throw messages.createError('StillInProgressError', [soi.Status], ['action.StillInProgress']);
  }
  if (soi.Status === 'Deleted') {
    // 3. SOI is deleted
    cache.unset(jobId);
    await cache.write();
    throw messages.createError('ScratchOrgDeletedError');
  }
  // 4. SOI might have errors: throw nice errors from sfdx-core with all the status code mappings.
  // if this passes, it returns an Active, error free SOI
  checkScratchOrgInfoForErrors(soi, hubOrg.getUsername(), logger);
  await emit({ stage: 'available', scratchOrgInfo: soi });
  // At this point, the scratch org is "good".

  // Some hubs have all the usernames set to `null`
  const username = soi.Username ?? soi.SignupUsername;

  // re-auth only if the org isn't in GlobalInfo
  const globalInfo = await GlobalInfo.getInstance();
  const scratchOrgAuthInfo = globalInfo.orgs.has(username)
    ? await AuthInfo.create({
        username,
      })
    : await authorizeScratchOrg({
        scratchOrgInfoComplete: soi,
        hubOrg,
        clientSecret,
        signupTargetLoginUrlConfig,
        retry: 0,
      });

  const scratchOrg = await Org.create({ aliasOrUsername: username });

  await emit({ stage: 'deploy settings', scratchOrgInfo: soi });
  const settingsGenerator = new SettingsGenerator();
  settingsGenerator.extract({ ...soi, ...definitionjson });
  const [authInfo] = await Promise.all([
    resolveUrl(scratchOrgAuthInfo),
    deploySettings(
      scratchOrg,
      settingsGenerator,
      apiVersion ??
        (new ConfigAggregator().getPropertyValue('apiVersion') as string) ??
        (await scratchOrg.retrieveMaxApiVersion())
    ),
  ]);

  await scratchOrgAuthInfo.handleAliasAndDefaultSettings({
    alias,
    setDefault: setDefault ?? false,
    setDefaultDevHub: false,
  });
  cache.unset(soi.Id);
  const authFields = authInfo.getFields();

  await Promise.all([emit({ stage: 'done', scratchOrgInfo: soi }), cache.write(), emitPostOrgCreate(authFields)]);

  return {
    username,
    scratchOrgInfo: soi,
    authInfo,
    authFields,
    warnings: [],
  };
};

export const scratchOrgCreate = async (options: ScratchOrgCreateOptions): Promise<ScratchOrgCreateResult> => {
  const logger = await Logger.child('scratchOrgCreate');

  logger.debug('scratchOrgCreate');
  await emit({ stage: 'prepare request' });
  const {
    hubOrg,
    connectedAppConsumerKey,
    durationDays = 1,
    nonamespace,
    noancestors,
    wait = Duration.minutes(DEFAULT_STREAM_TIMEOUT_MINUTES),
    retry = 0,
    apiversion: apiversion,
    definitionjson,
    definitionfile,
    orgConfig,
    clientSecret = undefined,
    alias,
    setDefault = false,
  } = options;

  validateDuration(durationDays);
  validateRetry(retry);

  const { scratchOrgInfoPayload, ignoreAncestorIds, warnings } = await getScratchOrgInfoPayload({
    definitionjson,
    definitionfile,
    connectedAppConsumerKey,
    durationDays,
    nonamespace,
    noancestors,
    orgConfig,
  });

  const scratchOrgInfo = await generateScratchOrgInfo({
    hubOrg,
    scratchOrgInfoPayload,
    nonamespace,
    ignoreAncestorIds,
  });

  // gets the scratch org settings (will use in both signup paths AND to deploy the settings)
  const settingsGenerator = new SettingsGenerator();
  const settings = await settingsGenerator.extract(scratchOrgInfo);
  logger.debug(`the scratch org def file has settings: ${settingsGenerator.hasSettings()}`);

  const [scratchOrgInfoRequestResult, signupTargetLoginUrlConfig] = await Promise.all([
    // creates the scratch org info in the devhub
    requestScratchOrgCreation(hubOrg, scratchOrgInfo, settingsGenerator),
    getSignupTargetLoginUrl(),
  ]);

  const scratchOrgInfoId = ensureString(getString(scratchOrgInfoRequestResult, 'id'));
  const cache = await ScratchOrgCache.create();
  cache.set(scratchOrgInfoId, {
    hubUsername: hubOrg.getUsername(),
    hubBaseUrl: hubOrg.getField(Org.Fields.INSTANCE_URL)?.toString(),
    definitionjson: { ...(definitionjson ? JSON.parse(definitionjson) : {}), ...settings },
    clientSecret,
    alias,
    setDefault,
  });
  await cache.write();
  logger.debug(`scratch org has recordId ${scratchOrgInfoId}`);

  // this is where we stop--no polling
  if (wait.minutes === 0) {
    const soi = (await hubOrg
      .getConnection()
      .sobject('ScratchOrgInfo')
      .retrieve(scratchOrgInfoId)) as unknown as ScratchOrgInfo;
    return {
      username: soi.SignupUsername,
      warnings: [],
      scratchOrgInfo: soi,
    };
  }

  const scratchOrgInfoResult = await pollForScratchOrgInfo(hubOrg, scratchOrgInfoId, wait);

  const scratchOrgAuthInfo = await authorizeScratchOrg({
    scratchOrgInfoComplete: scratchOrgInfoResult,
    hubOrg,
    clientSecret,
    signupTargetLoginUrlConfig,
    retry: retry || 0,
  });

  // we'll need this scratch org connection later;
  const scratchOrg = await Org.create({
    aliasOrUsername: scratchOrgInfoResult.Username ?? scratchOrgInfoResult.SignupUsername,
  });
  const username = scratchOrg.getUsername();
  logger.debug(`scratch org username ${username}`);

  await emit({ stage: 'deploy settings', scratchOrgInfo: scratchOrgInfoResult });

  const [authInfo] = await Promise.all([
    resolveUrl(scratchOrgAuthInfo),
    deploySettings(
      scratchOrg,
      settingsGenerator,
      apiversion ??
        (new ConfigAggregator().getPropertyValue('apiVersion') as string) ??
        (await scratchOrg.retrieveMaxApiVersion())
    ),
  ]);

  await scratchOrgAuthInfo.handleAliasAndDefaultSettings({
    alias,
    setDefault,
    setDefaultDevHub: false,
  });
  cache.unset(scratchOrgInfoId);
  const authFields = authInfo.getFields();
  await Promise.all([
    emit({ stage: 'done', scratchOrgInfo: scratchOrgInfoResult }),
    cache.write(),
    emitPostOrgCreate(authFields),
  ]);

  return {
    username,
    scratchOrgInfo: scratchOrgInfoResult,
    authInfo,
    authFields: authInfo?.getFields(),
    warnings,
  };
};

const getSignupTargetLoginUrl = async (): Promise<string | undefined> => {
  try {
    const project = await SfProject.resolve();
    const projectJson = await project.resolveProjectConfig();
    return projectJson.signupTargetLoginUrl as string;
  } catch {
    // a project isn't required for org:create
  }
};

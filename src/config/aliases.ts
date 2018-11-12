/*
 * Copyright (c) 2018, salesforce.com, inc.
 * All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 * For full license text, see the LICENSE file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import { Dictionary } from '@salesforce/ts-types';
import { SfdxError } from '../sfdxError';
import { ConfigFile } from './configFile';
import { ConfigGroup } from './configGroup';

const ALIAS_FILE_NAME = 'alias.json';

/**
 * Different groups of aliases. Currently only support orgs.
 * @typedef AliasGroup
 * @property {string} ORGS
 */
export enum AliasGroup {
  ORGS = 'orgs'
}

/**
 * Aliases specify alternate names for groups of properties used by the Salesforce CLI, such as orgs.
 * By default, all aliases are stored under 'orgs', but groups allow aliases to be applied for
 * other commands, settings, and parameters.
 *
 * **Note:** All aliases are stored at the global level.
 *
 * @extends ConfigGroup
 *
 * @example
 * const aliases = await Aliases.retrieve<Aliases>();
 * aliases.set('myAlias', 'username@company.org');
 * await aliases.write();
 * // Shorthand to get an alias.
 * const username: string = await Aliases.fetch('myAlias');
 * @see https://developer.salesforce.com/docs/atlas.en-us.sfdx_dev.meta/sfdx_dev/sfdx_dev_cli_usernames_orgs.htm
 */
export class Aliases extends ConfigGroup<ConfigGroup.Options> {
  /**
   * The aliases state file filename.
   * @override
   * @returns {string}
   */
  public static getFileName(): string {
    return ALIAS_FILE_NAME;
  }

  /**
   * Get Aliases specific options.
   * @returns {ConfigGroupOptions}
   */
  public static getDefaultOptions(): ConfigGroup.Options {
    return ConfigGroup.getOptions(AliasGroup.ORGS, Aliases.getFileName());
  }

  public static async retrieve<T extends ConfigFile<ConfigFile.Options>>(
    options?: ConfigFile.Options
  ): Promise<T> {
    const aliases: ConfigFile<ConfigFile.Options> = await Aliases.create(
      (options as ConfigGroup.Options) || Aliases.getDefaultOptions()
    );
    await aliases.read();
    return aliases as T;
  }

  /**
   * Updates a group of aliases in a bulk save.
   * @param {array} aliasKeyAndValues An array of strings in the format `<alias>=<value>`.
   * Each element will be saved in the Aliases state file under the group.
   * @param {AliasGroup} [group = AliasGroup.ORGS] The group the alias belongs to. Defaults to ORGS.
   * @returns {Promise<object>} The new aliases that were saved.
   * @example
   * const aliases = await Aliases.parseAndUpdate(['foo=bar', 'bar=baz'])
   */
  public static async parseAndUpdate(
    aliasKeyAndValues: string[],
    group: AliasGroup = AliasGroup.ORGS
  ): Promise<object> {
    const newAliases: Dictionary<string> = {};
    if (aliasKeyAndValues.length === 0) {
      throw SfdxError.create('@salesforce/core', 'core', 'NoAliasesFound', []);
    }

    for (const arg of aliasKeyAndValues) {
      const split = arg.split('=');

      if (split.length !== 2) {
        throw SfdxError.create('@salesforce/core', 'core', 'InvalidFormat', [
          arg
        ]);
      }
      const [name, value] = split;
      newAliases[name] = value || undefined;
    }

    const aliases: Aliases = await Aliases.create(Aliases.getDefaultOptions());

    return await aliases.updateValues(newAliases, group);
  }

  /**
   * Get an alias from a key and group. Shorthand for `Alias.retrieve().get(key)`.
   * @param {string} key The value of the alias to match
   * @param {string} [group=AliasGroup.Orgs] The group the alias belongs to. Defaults to Orgs
   * @returns {Promise<string>} The promise resolved when the alias is retrieved
   */
  public static async fetch(
    key: string,
    group = AliasGroup.ORGS
  ): Promise<string> {
    const aliases = (await Aliases.retrieve(
      Aliases.getDefaultOptions()
    )) as Aliases;
    return aliases.getInGroup(key, group) as string;
  }

  public constructor(options: ConfigGroup.Options) {
    super(options);
  }
}
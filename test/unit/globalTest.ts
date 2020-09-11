/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import * as path from 'path';
import { expect } from 'chai';
import { Global, Mode } from '../../src/global';
import { testSetup } from '../../src/testSetup';
import { fs } from '../../src/util/fs';

// Setup the test environment.
const $$ = testSetup();

describe('Global', () => {
  describe('environmentMode', () => {
    const sfdxEnv = process.env.SFDX_ENV;

    after(() => {
      process.env.SFDX_ENV = sfdxEnv;
    });

    it('uses SFDX_ENV mode', () => {
      process.env.SFDX_ENV = 'development';
      expect(Global.getEnvironmentMode() === Mode.DEVELOPMENT).to.be.true;
      expect(Global.getEnvironmentMode() === Mode.PRODUCTION).to.be.false;
      expect(Global.getEnvironmentMode() === Mode.DEMO).to.be.false;
      expect(Global.getEnvironmentMode() === Mode.TEST).to.be.false;
    });

    it('is production by default', () => {
      delete process.env.SFDX_ENV;
      expect(Global.getEnvironmentMode() === Mode.DEVELOPMENT).to.be.false;
      expect(Global.getEnvironmentMode() === Mode.PRODUCTION).to.be.true;
      expect(Global.getEnvironmentMode() === Mode.DEMO).to.be.false;
      expect(Global.getEnvironmentMode() === Mode.TEST).to.be.false;
    });
  });

  describe('createDir', () => {
    it('should create the global dir when no args passed', async () => {
      const mkdirpSpy = $$.SANDBOX.spy(fs, 'mkdirp');
      await Global.createDir();
      expect(mkdirpSpy.called).to.be.true;
      expect(mkdirpSpy.firstCall.args[0]).to.equal(Global.DIR);
      expect(mkdirpSpy.firstCall.args[1]).to.equal(fs.DEFAULT_USER_DIR_MODE);
    });

    it('should create a dir within the global dir when a dirPath is passed', async () => {
      const mkdirpSpy = $$.SANDBOX.spy(fs, 'mkdirp');
      const dirPath = path.join('some', 'dir', 'path');
      await Global.createDir(dirPath);
      expect(mkdirpSpy.called).to.be.true;
      expect(mkdirpSpy.firstCall.args[0]).to.equal(path.join(Global.DIR, dirPath));
      expect(mkdirpSpy.firstCall.args[1]).to.equal(fs.DEFAULT_USER_DIR_MODE);
    });
  });
});

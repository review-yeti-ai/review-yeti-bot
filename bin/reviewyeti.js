#!/usr/bin/env node
'use strict';

require('../dist/cli/reviewyetiCli.js').main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}).catch((error) => {
  console.error(`reviewyeti: ${error.message}`);
  process.exitCode = 1;
});

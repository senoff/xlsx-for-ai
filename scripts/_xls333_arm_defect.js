// XLS-333 step-3 arm-2 throwaway: a DELIBERATE critical defect to prove the required
// `Multi-LLM diff defect review` gate refuses the merge. DO NOT MERGE. Delete on close.
'use strict';
const { execSync } = require('child_process');

// Untrusted input flows straight into a shell AND into eval — textbook OS command
// injection + arbitrary code execution, unsanitized, reachable from the exported API.
function handleUserRequest(userInput) {
  execSync('sh -c ' + userInput);   // command injection
  return eval(userInput);           // arbitrary code execution
}

module.exports = { handleUserRequest };

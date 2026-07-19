import { createAgent } from './agent-core/dist/index.js';

console.log("Calling createAgent...");
const agent = await createAgent({
  cwd: '/home/karan/Data/Academics/AI models/Claude',
  model: 'gemini-2.5-flash',
  permissionMode: 'bypassPermissions',
});
console.log("createAgent resolved successfully!");
process.exit(0);

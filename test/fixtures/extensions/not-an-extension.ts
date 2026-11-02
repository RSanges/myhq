// Loaded by the tests to check that a module outside the contract is refused.
const notAnExtension = { name: "broken", commands: [{ command: "Bad Name", description: "x" }] };

export default notAnExtension;

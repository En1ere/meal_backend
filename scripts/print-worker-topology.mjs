// Read-only deployment planning command. It never opens a database connection or starts a worker.
const { workerTopology } = await import('../dist/src/modules/operational-runtime/worker-topology.js');
console.log(JSON.stringify(workerTopology(), null, 2));

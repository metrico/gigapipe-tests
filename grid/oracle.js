// Reference evaluators for the grid suites: expected results are computed
// from the samples a test wrote, never stored.
module.exports = {
  prom: require('./oracle.prom'),
  logql: require('./oracle.logql')
}

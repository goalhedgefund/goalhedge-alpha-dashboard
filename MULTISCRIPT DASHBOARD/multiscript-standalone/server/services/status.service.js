function createStatusService({ runner }) {
  function getStatus() {
    return runner.getStatus();
  }

  return { getStatus };
}

module.exports = { createStatusService };

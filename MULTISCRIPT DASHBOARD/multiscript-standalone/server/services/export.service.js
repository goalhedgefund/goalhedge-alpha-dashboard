function createExportService({ runner, getLoggingConfig }) {
  function getExportPath(frame) {
    const loggingConfig = typeof getLoggingConfig === 'function'
      ? getLoggingConfig()
      : { tradeFiles: {} };
    return loggingConfig.tradeFiles[frame] || loggingConfig.tradeFiles['15'];
  }

  async function exportWorkbook(frame) {
    return {
      frame,
      filePath: getExportPath(frame),
      status: runner.getStatus()
    };
  }

  return { exportWorkbook, getExportPath, getLoggingConfig };
}

module.exports = { createExportService };

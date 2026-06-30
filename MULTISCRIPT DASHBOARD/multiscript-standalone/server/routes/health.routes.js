const express = require('express');

function createHealthRoutes({ runner }) {
  const router = express.Router();
  router.get('/', (req, res) => {
    res.json({
      ok: true,
      runner: runner.getStatus().runnerState,
      connectionState: runner.getStatus().connectionState
    });
  });
  return router;
}

module.exports = { createHealthRoutes };

let dmEngineRef = null;

function setDmEngine(engine) {
  dmEngineRef = engine;
}

function getDmEngine() {
  return dmEngineRef;
}

module.exports = { setDmEngine, getDmEngine };

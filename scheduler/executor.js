'use strict';

const handlers = {
  prowess_ohlcv:      () => require('./handlers/prowessOhlcv'),
  prowess_quarterly:  () => require('./handlers/prowessFilings'),
  prowess_annual:     () => require('./handlers/prowessFilings'),
  prowess_batch_poll: () => require('./handlers/prowessBatchPoll'),
  prowess_daily_batch: () => require('./handlers/prowessDailyBatch'),
  bse_discovery:      () => require('./handlers/bseDiscovery'),
  pipeline_dispatch:  () => require('./handlers/pipelineDispatch'),
  pipeline_dispatch_l1_multi: () => require('./handlers/pipelineDispatchL1Multi'),
  pipeline_dispatch_l2_multi: () => require('./handlers/pipelineDispatchL2Multi'),
  pipeline_dispatch_l2_compressed_multi: () => require('./handlers/pipelineDispatchL2CompressedMulti'),
  pipeline_dispatch_l3_multi: () => require('./handlers/pipelineDispatchL3Multi'),
  technicals_daily_batch: () => require('./handlers/technicalsDailyBatch'),
};

async function dispatch(jobType, config = {}) {
  const loader = handlers[jobType];
  if (!loader) throw new Error(`Unknown job_type: "${jobType}"`);
  const handler = loader();
  // Pass jobType as second arg so handlers that serve multiple job_types can branch
  return handler.run(config, jobType);
}

module.exports = { dispatch };

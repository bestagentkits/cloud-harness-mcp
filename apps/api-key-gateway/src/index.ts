import {
  createGatewayHandler,
  type GatewayEnv,
  type UpstreamFetch
} from './gateway.js';

const handler = createGatewayHandler(fetch as UpstreamFetch);

export default {
  fetch(request: Request, env: GatewayEnv): Promise<Response> {
    return handler(request, env);
  }
};

import { requireCondition, type RuntimeInput, type RuntimeProvider, type WorkPackage } from '../contracts.js';
import { bearer, jsonBody, respond, server } from '../http.js';
export function workerService(provider: RuntimeProvider, controllerToken: string) {
  return server(async (request, response, url) => {
    if (url.pathname === '/health' && request.method === 'GET') { respond(response, 200, { service: 'worker', pid: process.pid, provider: provider.capabilities().provider }); return; }
    requireCondition(bearer(request) === controllerToken, 401, 'runtime_authentication_required');
    if (url.pathname === '/capabilities' && request.method === 'GET') { respond(response, 200, provider.capabilities()); return; }
    if (url.pathname === '/sessions' && request.method === 'POST') {
      const body = await jsonBody(request);
      requireCondition(body.work && typeof body.work === 'object', 400, 'work_required');
      respond(response, 201, await provider.createSession(body.work as WorkPackage)); return;
    }
    const match = /^\/sessions\/([^/]+)\/(input|events|status|cancel|append|pause|resume)$/.exec(url.pathname);
    if (match) {
      const id = match[1]!, operation = match[2];
      if (operation === 'events' && request.method === 'GET') { respond(response, 200, { events: provider.events(id, Number(url.searchParams.get('after') ?? '0')) }); return; }
      if (operation === 'status' && request.method === 'GET') { respond(response, 200, provider.status(id)); return; }
      if (operation === 'input' && request.method === 'POST') {
        const body = await jsonBody(request);
        requireCondition(body.input && typeof body.input === 'object', 400, 'input_required');
        respond(response, 202, await provider.submitInput(id, body.input as RuntimeInput)); return;
      }
      if (operation === 'cancel' && request.method === 'POST') { respond(response, 202, provider.cancel(id)); return; }
      if (['append', 'pause', 'resume'].includes(operation!) && request.method === 'POST') { respond(response, 501, { error: `${operation}_not_supported` }); return; }
    }
    respond(response, 404, { error: 'not_found' });
  });
}

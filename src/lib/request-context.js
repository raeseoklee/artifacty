import { AsyncLocalStorage } from "node:async_hooks";
const requests = new AsyncLocalStorage();
export const runWithRequestContext = (context, action) => requests.run(Object.freeze(context), action);
export const requestClientAddress = () => requests.getStore()?.clientAddress;

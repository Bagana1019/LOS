export interface Principal {
  customerId: string;
  sessionId: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      correlationId: string;
      principal?: Principal;
    }
  }
}

/** Downstream дуудлагад дамжих контекст: хэн, ямар correlation-аар. */
export interface CallContext {
  customerId: string;
  correlationId: string;
}

export interface AnonymousContext {
  correlationId: string;
}

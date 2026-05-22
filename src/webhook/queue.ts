export interface Job<T = unknown> {
  id: string;
  payload: T;
}

export type Handler<T> = (job: Job<T>) => Promise<void>;

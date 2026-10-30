export interface Defaults {
  model: string;
  instructions: string;
  reasoning_effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  verbosity?: 'low' | 'medium' | 'high';
  max_output_tokens: number;
  timeout_ms: number;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cached_input_tokens?: number;
  reasoning_tokens?: number;
}

// Identifiers OpenAI attaches to an error; never its free-text message, which can echo request content.
export type UpstreamDetails = {
  upstream_request_id?: string;
  upstream_code?: string;
  upstream_param?: string;
};

export type RequestState =
  | 'running'
  | 'completed'
  | 'refused'
  | 'incomplete'
  | 'failed'
  | 'recovery_required'
  | 'unknown_outcome'
  | 'abandoned';

export interface ChatResult {
  request_id: string;
  session_id: string;
  response_id?: string;
  model: string;
  status: RequestState;
  message: string;
  usage: Usage | null;
  options: Omit<Defaults, 'model' | 'instructions'> & {
    instructions_set: boolean;
  };
  refusal?: string;
  error?: { code: string; message: string } & UpstreamDetails;
  incomplete_reason?: string;
}

export interface RequestRecord {
  id: string;
  sessionId: string;
  digest: string;
  state: RequestState;
  responseId?: string;
  owner?: string;
  leaseUntil?: number;
  result?: ChatResult;
  usage?: Usage;
  options: Omit<Defaults, 'instructions'> & { instructions_set: boolean };
  createdAt: number;
  updatedAt: number;
  baseRevision: number;
}

export interface SessionRecord {
  id: string;
  defaults: Defaults;
  responseId?: string;
  activeRequestId?: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

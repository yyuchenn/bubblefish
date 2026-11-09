/// <reference lib="webworker" />
import {
  findSearchMatches,
  prepareSearchReplacement,
  type SearchWorkerReply,
  type SearchWorkerRequest,
} from './search';

self.onmessage = ({ data }: MessageEvent<SearchWorkerRequest>) => {
  let reply: SearchWorkerReply;
  try {
    reply = {
      id: data.id,
      result:
        data.type === 'search'
          ? findSearchMatches(data.fields, data.options)
          : prepareSearchReplacement(data.fields, data.options, data.replacement, data.current),
    };
  } catch (error) {
    reply = { id: data.id, error: error instanceof Error ? error.message : String(error) };
  }
  self.postMessage(reply);
};

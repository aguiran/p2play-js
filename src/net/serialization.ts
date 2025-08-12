import { NetMessage, SerializationStrategy } from "../types";

export interface Serializer {
  encode(msg: NetMessage): string | ArrayBuffer;
  decode(data: string | ArrayBuffer): NetMessage;
}

export function createSerializer(strategy: SerializationStrategy = "json"): Serializer {
  if (strategy === "json") {
    return {
      encode: (msg) => JSON.stringify(msg),
      decode: (data) => (typeof data === "string" ? JSON.parse(data) : JSON.parse(new TextDecoder().decode(data))),
    };
  }
  if (strategy === "binary-min") {
    // Minimal binary: just UTF-8 JSON for demo (hook for future CBOR/Flatbuffers)
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    return {
      encode: (msg) => enc.encode(JSON.stringify(msg)).buffer,
      decode: (data) => JSON.parse(typeof data === "string" ? data : dec.decode(data as ArrayBuffer)),
    };
  }
  // json+gzip would require a gzip impl; leave as json for now
  return {
    encode: (msg) => JSON.stringify(msg),
    decode: (data) => (typeof data === "string" ? JSON.parse(data) : JSON.parse(new TextDecoder().decode(data))),
  };
}


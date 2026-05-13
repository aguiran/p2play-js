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
    /**
     * "binary-min": binary transport for JSON payloads (UTF-8 encoded as ArrayBuffer).
     * Useful to force the binary path on RTCDataChannel.send() instead of string mode.
     * The wire format (UTF-8 JSON) is stable; future versions may add CBOR/FlatBuffers/MessagePack
     * encoders under the same option without changing the public API.
     */
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    return {
      encode: (msg) => enc.encode(JSON.stringify(msg)).buffer,
      decode: (data) => JSON.parse(typeof data === "string" ? data : dec.decode(data as ArrayBuffer)),
    };
  }
  throw new Error(`Unknown serialization strategy: ${String(strategy)}`);
}


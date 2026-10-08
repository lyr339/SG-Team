import type { Message, MessageType } from "@bufbuild/protobuf";
export interface WireTypes {
  Client: MessageType<Message>;
  Server: MessageType<Message>;
  State: MessageType<Message>;
  messageType(name: string): MessageType<Message>;
}
export function createWireTypes(schema?: unknown): WireTypes;

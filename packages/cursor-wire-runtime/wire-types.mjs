import { proto3 } from "@bufbuild/protobuf";
import schemaData from "./schema.json" with { type: "json" };

export function createWireTypes(schema = schemaData) {
  const messages = new Map(),
    enums = new Map();
  // Additive, independently checked against public SDK 1.0.36, not a rewrite of
  // the original 3.21.12 schema. Both normal known/unknown fields remain intact.
  const overlay = {
    "agent.v1.TurnEndedUpdate": [
      { no: 6, name: "ended_at_ms", kind: "scalar", type: 4, optional: true },
    ],
    "agent.v1.ConversationStateStructure": [
      {
        no: 38,
        name: "recent_user_message_ids",
        kind: "scalar",
        type: 9,
        repeated: true,
      },
      {
        no: 39,
        name: "recent_user_message_ids_older_turn_count",
        kind: "scalar",
        type: 13,
        optional: true,
      },
    ],
  };
  function enumType(name) {
    if (enums.has(name)) return enums.get(name);
    const definition = schema.enums[name];
    if (!definition) throw Error("Unresolved enum type " + name);
    const value = proto3.makeEnum(name, definition.values);
    enums.set(name, value);
    return value;
  }
  function messageType(name) {
    if (messages.has(name)) return messages.get(name);
    const definition = schema.messages[name];
    if (!definition) throw Error("Unresolved message type " + name);
    const additions = (overlay[name] || []).filter(
      (f) => !definition.fields.some((old) => old.no === f.no),
    );
    const ctor = proto3.makeMessageType(name, () =>
      [...definition.fields, ...additions].map((field) => {
        const result = {
          no: field.no,
          name: field.name,
          kind: field.kind,
          repeated: !!field.repeated,
        };
        if (field.oneof) result.oneof = field.oneof;
        if (field.optional) result.opt = true;
        if (field.kind === "message") result.T = messageType(field.typeName);
        else if (field.kind === "enum")
          result.T = proto3.getEnumType(enumType(field.enumTypeName));
        else if (field.kind === "map") {
          result.K = field.keyType;
          if (field.valueKind === "message")
            result.V = { kind: "message", T: messageType(field.valueTypeName) };
          else if (
            field.valueKind === "scalar" &&
            typeof field.valueType === "number"
          )
            result.V = { kind: "scalar", T: field.valueType };
          else throw Error("Unresolved map value " + name + "." + field.name);
        } else if (typeof field.type === "number") result.T = field.type;
        else throw Error("Unresolved scalar " + name + "." + field.name);
        return result;
      }),
    );
    messages.set(name, ctor);
    return ctor;
  }
  return {
    messageType,
    Client: messageType("agent.v1.AgentClientMessage"),
    Server: messageType("agent.v1.AgentServerMessage"),
    State: messageType("agent.v1.ConversationStateStructure"),
  };
}

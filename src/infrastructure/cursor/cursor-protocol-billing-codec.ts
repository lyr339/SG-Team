import { BILLING_PROTO_SCHEMA } from './cursor-protocol-billing-schema'

type Field = { no: number; name: string; kind: string; type?: string | number; typeName?: string; repeated?: boolean }
const schema = BILLING_PROTO_SCHEMA as Record<string, { fields: readonly Field[] }>
export type ProtoObject = Record<string, unknown>
function varint(body: Buffer, start: number): { value: bigint; end: number } {
  let value = 0n, end = start
  for (let shift = 0n; shift < 70n; shift += 7n) {
    if (end >= body.length) throw new Error('额度响应的 protobuf 数据不完整。')
    const byte = body[end++]!
    if (shift === 63n && byte > 1) throw new Error('额度响应整数越界。')
    value |= BigInt(byte & 127) << shift
    if (!(byte & 128)) return { value, end }
  }
  throw new Error('额度响应整数无效。')
}
export function decodeBillingProto(body: Buffer, name: string, depth = 0): ProtoObject {
  if (body.length > 2 * 1024 * 1024 || depth > 32) throw new Error('额度响应超出安全读取上限。')
  const result: ProtoObject = Object.create(null) as ProtoObject
  const fields = new Map(schema[name]?.fields.map(field => [field.no, field]) ?? [])
  let offset = 0, entries = 0
  while (offset < body.length) {
    if (++entries > 10000) throw new Error('额度响应字段过多。')
    const tag = varint(body, offset); offset = tag.end
    const number = Number(tag.value >> 3n), wire = Number(tag.value & 7n), field = fields.get(number)
    if (!number || number > 536870911) throw new Error('额度响应字段号无效。')
    let value: unknown
    if (wire === 0) {
      const item = varint(body, offset); offset = item.end
      const signed = field && [3,5,14].includes(Number(field.type)) ? BigInt.asIntN(field.type === 5 || field.type === 14 ? 32 : 64,item.value) : item.value
      if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error('额度响应整数无法精确表示。')
      value = field?.type === 8 ? signed !== 0n : Number(signed)
    } else if (wire === 1 || wire === 5) {
      const length = wire === 1 ? 8 : 4
      if (offset + length > body.length) throw new Error('额度响应字段截断。')
      value = field?.type === 1 ? body.readDoubleLE(offset) : field?.type === 2 ? body.readFloatLE(offset) : undefined
      offset += length
    } else if (wire === 2) {
      const size = varint(body, offset); offset = size.end
      if (size.value > BigInt(body.length-offset)) throw new Error('额度响应字段截断。')
      const chunk = body.subarray(offset, offset + Number(size.value)); offset += chunk.length
      value = field?.kind === 'message' && field.typeName ? decodeBillingProto(chunk,field.typeName,depth+1) : field?.type === 9 ? new TextDecoder('utf8',{fatal:true}).decode(chunk) : undefined
    } else throw new Error('额度响应的 wire type 不受支持。')
    if (!field || value === undefined) continue
    if (field.repeated) { const list = result[field.name] as unknown[] | undefined; if (list) list.push(value); else result[field.name]=[value] }
    else result[field.name]=value
  }
  return result
}
function encodeInteger(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('只读查询参数无效。')
  let n=BigInt(value); const parts:number[]=[]
  do { parts.push(Number(n&127n)|(n>127n?128:0)); n>>=7n } while(n)
  return Buffer.from(parts)
}
export function usageWindowRequest(start: number, end: number): Buffer {
  return Buffer.concat([[2,start],[3,end],[6,1],[7,20]].map(([no,value])=>Buffer.concat([encodeInteger(no!*8),encodeInteger(value!)])))
}

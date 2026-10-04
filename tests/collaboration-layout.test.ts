import { describe, expect, it } from 'vitest'
import { graphLayout, graphMemberOrder, graphRoutes, graphInside, graphCrossing, sampleGraphPath, type GraphCurve } from '../src/renderer/src/team/collaboration-layout'
const ids = Array.from({length:8},(_,i)=>`slot-${i+1}`)
const edges = [{id:'a',from:'slot-1',to:'slot-2'},{id:'b',from:'slot-3',to:'slot-1'},{id:'c',from:'slot-1',to:'slot-4'},
  {id:'d',from:'slot-2',to:'slot-4'},{id:'e',from:'slot-1',to:'slot-5'},{id:'f',from:'slot-6',to:'slot-2'}]
describe('production collaboration routing',()=>{
 it('keeps all members, effective lead at left-centre, no lead in flat groups and at most two rows up to eight',()=>{
  for(const count of [1,2,4,6,8,16])for(const width of [360,640,1024])for(const lead of [undefined,'slot-2']) {
   const members=Array.from({length:count},(_,i)=>`slot-${i+1}`),g=graphLayout(members,lead,width)
   expect(g.nodes).toHaveLength(count)
   if(count<=8)expect(g.rows).toBeLessThanOrEqual(2)
   if(lead&&members.includes(lead)){const root=g.nodes.find(n=>n.id===lead)!;expect(root.y+root.h/2).toBe(g.height/2);expect(root.x).toBeLessThan(Math.min(...g.nodes.filter(n=>n.id!==lead).map(n=>n.x)))}
   for(const n of g.nodes){expect(n.x).toBeGreaterThanOrEqual(0);expect(n.y).toBeGreaterThanOrEqual(0);expect(n.x+n.w).toBeLessThanOrEqual(g.width);expect(n.y+n.h).toBeLessThanOrEqual(g.height)}
  }
 })
 it('uses exact symmetric docks, tangent-continuous curves and obstacle/crossing audits',()=>{
  for(const width of [640,1024])for(const lead of ['slot-1',undefined]) {
   const g=graphLayout(graphMemberOrder(ids,lead,edges),lead,width),p=graphRoutes(edges,g)
   expect(p.hasUnrouted).toBe(false);expect(p.crossings).toBe(0)
   const groups=new Map<string,number[]>();for(const port of p.ports){const key=`${port.nodeId}:${port.side}`;groups.set(key,[...(groups.get(key)??[]),port.offset])}
   for(const offsets of groups.values()){expect(offsets.reduce((s,n)=>s+n,0)).toBeCloseTo(0,8);if(offsets.length===1)expect(offsets[0]).toBe(0)}
   const lines=[...p.routes].map(([id,parts])=>({id,parts,s:sampleGraphPath(parts,3)}))
   for(const l of lines){expect(l.parts.length).toBeLessThanOrEqual(2);const edge=edges.find(e=>e.id===l.id)!
    for(const q of l.s.points)for(const n of g.nodes)if(n.id!==edge.from&&n.id!==edge.to)expect(graphInside(q,n,2)).toBe(false)
    if(l.parts.length===2){const a=l.parts[0]!,b=l.parts[1]!,u={x:a[3].x-a[2].x,y:a[3].y-a[2].y},v={x:b[1].x-b[0].x,y:b[1].y-b[0].y};expect(u.x*v.y-u.y*v.x).toBeCloseTo(0,7);expect(u.x*v.x+u.y*v.y).toBeGreaterThan(0)}
   }
   for(let i=0;i<lines.length;i++)for(let j=i+1;j<lines.length;j++)expect(graphCrossing(lines[i]!.s,lines[j]!.s)).toBeUndefined()
  }
 })
 it('send/reply only reverses traversal; geometry and docks do not jump',()=>{
  const g=graphLayout(graphMemberOrder(ids,'slot-1',edges),'slot-1',1024),before=graphRoutes(edges,g)
  const flipped=edges.map(e=>({...e,from:e.to,to:e.from})),after=graphRoutes(flipped,g)
  expect(after.ports).toEqual(before.ports)
  for(const e of edges)expect(after.routes.get(e.id)).toEqual([...before.routes.get(e.id)!].reverse().map(p=>[...p].reverse() as GraphCurve))
 })
})

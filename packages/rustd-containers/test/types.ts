import { Heap, List, Element, Ring, newRing, ringFrom, SuffixArray, heapInit, heapPop } from '../index.js';

const heap: Heap<number> = new Heap((a, b) => a - b, [3, 1, 2]);
const popped: number | undefined = heap.pop();
heapInit(heap);
const again: number | undefined = heapPop(heap);

const list: List<string> = new List();
const el: Element<string> = list.pushBack('x');
const maybe: Element<string> | null = list.insertBefore('y', el);
const removed: string = list.remove(el);

const ring: Ring<number> = ringFrom([1, 2, 3]);
const empty: Ring<number> = newRing(0);
empty.do((value: number) => { value + 1; });

const sa: SuffixArray = SuffixArray.build(new Uint8Array([1]));
const hits: Uint32Array = sa.lookup(new Uint8Array([1]));
const copy: Uint8Array = sa.bytes();
sa.dispose();

// @ts-expect-error compare is a function, not a string
const badHeap: Heap<number> = new Heap('nope');
// @ts-expect-error lookup query is bytes, not a string
SuffixArray.build(new Uint8Array()).lookup('an');
// @ts-expect-error list values are strings here
const wrong: number = removed;
void popped; void again; void maybe; void ring; void hits; void copy;

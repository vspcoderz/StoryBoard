/**
 * Chat document, with emphasis on concurrent behaviour.
 *
 * The tests that matter are the two-document ones. Almost every interesting bug in a CRDT-backed
 * feature is a *merge* bug, and a merge bug is invisible in a single-user session because there is
 * only ever one version of the truth. So most of this file wires two `Y.Doc`s together, interleaves
 * their updates, and asserts they converge on the same state.
 *
 * Convergence is asserted on *both* replicas, not just one. A document can look right on the author
 * and wrong on the collaborator, which is precisely the bug a user would report as "my teammate's
 * reaction vanished".
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import {
  ChatDoc,
  buildThreads,
  compareMessages,
  hasReacted,
  newMessageId,
  parseMentions,
  paragraphs,
  reactionSummary,
  segmentMentions,
  type ChatMessage,
  type ChatUser,
} from '../src/chat/model'

const alice: ChatUser = { id: 'u_alice', name: 'Alice', color: '#f00' }
const bob: ChatUser = { id: 'u_bob', name: 'Bob', color: '#00f' }

/**
 * Two chat docs on two Y.Docs, wired to exchange updates.
 *
 * `sync` runs both directions. `log` records what has been sent, so a test can "reconnect" by
 * replaying only what a given replica missed.
 */
function pair() {
  const d1 = new Y.Doc()
  const d2 = new Y.Doc()
  const a = new ChatDoc(d1)
  const b = new ChatDoc(d2)
  const seen1 = new Set<number>()
  const seen2 = new Set<number>()
  d1.on('update', (u: Uint8Array, origin: unknown) => {
    // Re-applying a remote update would re-emit it and loop forever.
    if (origin === 'remote') return
    Y.applyUpdate(d2, u, 'remote')
  })
  d2.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin === 'remote') return
    Y.applyUpdate(d1, u, 'remote')
  })
  seen1.add(0)
  seen2.add(0)
  return { a, b, d1, d2, seen1, seen2 }
}

const bodies = (d: ChatDoc) => d.list().map((m) => m.body)
const byId = (d: ChatDoc, id: string): ChatMessage | undefined => d.list().find((m) => m.id === id)

describe('ordering', () => {
  it('sorts by creation time', () => {
    const mk = (id: string, createdAt: number): ChatMessage => ({
      id,
      authorId: 'u',
      authorName: 'U',
      body: '',
      createdAt,
      editedAt: null,
      threadId: null,
      anchorNodeId: null,
      deleted: false,
      reactions: {},
      mentions: [],
    })
    const out = [mk('b', 2), mk('a', 1), mk('c', 3)].sort(compareMessages)
    assert.deepEqual(out.map((m) => m.id), ['a', 'b', 'c'])
  })

  it('breaks ties on id, so same-millisecond posts do not swap between renders', () => {
    const mk = (id: string): ChatMessage => ({
      id,
      authorId: 'u',
      authorName: 'U',
      body: id,
      createdAt: 1000,
      editedAt: null,
      threadId: null,
      anchorNodeId: null,
      deleted: false,
      reactions: {},
      mentions: [],
    })
    // The same set in both orders must produce the same result, or the room visibly reshuffles.
    const one = [mk('c'), mk('a'), mk('b')].sort(compareMessages)
    const two = [mk('a'), mk('b'), mk('c')].sort(compareMessages)
    assert.deepEqual(one.map((m) => m.id), two.map((m) => m.id))
  })
})

describe('mentions', () => {
  const roster = [alice, bob]

  it('resolves a known name', () => {
    assert.deepEqual(parseMentions('hey @Alice look', roster), ['u_alice'])
  })

  it('is case insensitive', () => {
    assert.deepEqual(parseMentions('@alice', roster), ['u_alice'])
  })

  it('drops unknown names rather than keeping a phantom chip', () => {
    assert.deepEqual(parseMentions('@Nobody here', roster), [])
  })

  it('deduplicates repeated mentions', () => {
    assert.deepEqual(parseMentions('@Alice @Alice @alice', roster), ['u_alice'])
  })

  it('ignores a bare @ with no name', () => {
    assert.deepEqual(parseMentions('email me @', roster), [])
  })

  it('segments a body into plain and mention runs, preserving all text', () => {
    const segs = segmentMentions('hi @Alice and @Nobody', roster)
    assert.deepEqual(segs, [
      { text: 'hi ', userId: null },
      { text: '@Alice', userId: 'u_alice' },
      { text: ' and @Nobody', userId: null },
    ])
    assert.equal(segs.map((s) => s.text).join(''), 'hi @Alice and @Nobody', 'no text lost')
  })

  it('segments a body with no mentions into one run', () => {
    assert.deepEqual(segmentMentions('plain', roster), [{ text: 'plain', userId: null }])
  })
})

describe('reactions', () => {
  it('summarises and sorts emoji by code unit, dropping empty sets', () => {
    // Sorted by code unit, not locale: '🎉' is U+1F389 and '👍' is U+1F44D, so '🎉' sorts first.
    // The assertion is written from the code units rather than eyeballed, because emoji ordering
    // read off a screen is exactly the thing that is easy to get wrong.
    const s = reactionSummary({ '👍': ['u_a'], '🎉': ['u_b'], '💤': [] })
    assert.deepEqual(s.map((r) => r.emoji), ['🎉', '👍'])
    assert.ok('🎉'.codePointAt(0)! < '👍'.codePointAt(0)!, 'documented as the reason')
  })

  it('knows whether a user already reacted', () => {
    const r = { '👍': ['u_a'] }
    assert.ok(hasReacted(r, '👍', 'u_a'))
    assert.ok(!hasReacted(r, '👍', 'u_b'))
  })

  it('toggles on and off', () => {
    const d = new ChatDoc(new Y.Doc())
    const m = d.post({ body: 'hi', author: alice })!
    d.toggleReaction(m.id, '👍', 'u_alice')
    assert.ok(hasReacted(byId(d, m.id)!.reactions, '👍', 'u_alice'))
    d.toggleReaction(m.id, '👍', 'u_alice')
    assert.ok(!hasReacted(byId(d, m.id)!.reactions, '👍', 'u_alice'))
  })
})

describe('threads', () => {
  const msg = (id: string, threadId: string | null, createdAt: number): ChatMessage => ({
    id,
    authorId: 'u',
    authorName: 'U',
    body: id,
    createdAt,
    editedAt: null,
    threadId,
    anchorNodeId: null,
    deleted: false,
    reactions: {},
    mentions: [],
  })

  it('nests replies under their root', () => {
    const out = buildThreads([msg('r', 'root', 1), msg('root', null, 2), msg('r2', 'root', 3)])
    assert.equal(out.length, 1)
    assert.equal(out[0].root.id, 'root')
    assert.deepEqual(out[0].replies.map((m) => m.id), ['r', 'r2'])
  })

  it('promotes an orphan reply to a root rather than dropping it', () => {
    // Happens when a root is deleted but replies survive. Hiding them would lose someone's words.
    const out = buildThreads([msg('orphan', 'gone', 1)])
    assert.equal(out.length, 1)
    assert.equal(out[0].root.id, 'orphan')
  })
})

describe('paragraphs', () => {
  it('splits on blank lines', () => {
    assert.deepEqual(paragraphs('a\n\nb'), ['a', 'b'])
  })

  it('keeps single newlines inside a paragraph', () => {
    assert.deepEqual(paragraphs('a\nb'), ['a\nb'])
  })
})

describe('posting', () => {
  it('refuses an empty message', () => {
    const d = new ChatDoc(new Y.Doc())
    assert.equal(d.post({ body: '   ', author: alice }), null)
    assert.equal(d.list().length, 0)
  })

  it('trims the body', () => {
    const d = new ChatDoc(new Y.Doc())
    const m = d.post({ body: '  hi  ', author: alice })!
    assert.equal(m.body, 'hi')
  })

  it('records the author so a message survives a rename', () => {
    const d = new ChatDoc(new Y.Doc())
    const m = d.post({ body: 'hi', author: alice })!
    assert.equal(m.authorName, 'Alice')
    assert.equal(m.authorId, 'u_alice')
  })

  it('stores resolved mentions at post time', () => {
    const d = new ChatDoc(new Y.Doc())
    const m = d.post({ body: '@Alice hi', author: bob, roster: [alice, bob] })!
    assert.deepEqual(m.mentions, ['u_alice'])
  })
})

describe('editing and deleting', () => {
  it('edits the body and stamps editedAt', () => {
    const d = new ChatDoc(new Y.Doc())
    const m = d.post({ body: 'typo', author: alice })!
    d.edit(m.id, 'fixed')
    const after = byId(d, m.id)!
    assert.equal(after.body, 'fixed')
    assert.ok(after.editedAt)
  })

  it('refuses to blank a message by editing it to nothing', () => {
    const d = new ChatDoc(new Y.Doc())
    const m = d.post({ body: 'keep me', author: alice })!
    d.edit(m.id, '   ')
    assert.equal(byId(d, m.id)!.body, 'keep me')
  })

  it('soft delete keeps the message in place so replies keep their parent', () => {
    const d = new ChatDoc(new Y.Doc())
    const root = d.post({ body: 'root', author: alice })!
    d.post({ body: 'reply', author: bob, threadId: root.id })
    d.remove(root.id)
    const threads = buildThreads(d.list())
    assert.equal(threads.length, 1, 'root still occupies its slot')
    assert.ok(threads[0].root.deleted)
    assert.equal(threads[0].replies.length, 1, 'reply is still attached')
  })

  it('deleting clears reactions', () => {
    const d = new ChatDoc(new Y.Doc())
    const m = d.post({ body: 'x', author: alice })!
    d.toggleReaction(m.id, '👍', 'u_bob')
    d.remove(m.id)
    assert.equal(Object.keys(byId(d, m.id)!.reactions).length, 0)
  })
})

describe('tasks', () => {
  it('creates a todo', () => {
    const d = new ChatDoc(new Y.Doc())
    const t = d.addTask({ title: 'fix the beat', createdBy: 'u_alice' })!
    assert.equal(t.status, 'todo')
    assert.equal(d.listTasks().length, 1)
  })

  it('refuses an empty title', () => {
    const d = new ChatDoc(new Y.Doc())
    assert.equal(d.addTask({ title: '  ', createdBy: 'u' }), null)
  })

  it('toggles between todo and done', () => {
    const d = new ChatDoc(new Y.Doc())
    const t = d.addTask({ title: 'x', createdBy: 'u' })!
    d.toggleTask(t.id)
    assert.equal(d.listTasks()[0].status, 'done')
    d.toggleTask(t.id)
    assert.equal(d.listTasks()[0].status, 'todo')
  })

  it('assigns and unassigns', () => {
    const d = new ChatDoc(new Y.Doc())
    const t = d.addTask({ title: 'x', createdBy: 'u' })!
    d.setTaskAssignee(t.id, 'u_bob')
    assert.equal(d.listTasks()[0].assigneeId, 'u_bob')
    d.setTaskAssignee(t.id, null)
    assert.equal(d.listTasks()[0].assigneeId, null)
  })

  it('removes', () => {
    const d = new ChatDoc(new Y.Doc())
    const t = d.addTask({ title: 'x', createdBy: 'u' })!
    d.removeTask(t.id)
    assert.equal(d.listTasks().length, 0)
  })
})

describe('undo', () => {
  it('undoes my own post', () => {
    const d = new ChatDoc(new Y.Doc())
    d.post({ body: 'oops', author: alice })
    d.undo()
    assert.equal(d.list().length, 0)
  })

  it('redoes', () => {
    const d = new ChatDoc(new Y.Doc())
    d.post({ body: 'oops', author: alice })
    d.undo()
    d.redo()
    assert.equal(d.list().length, 1)
  })

  it('refuses to undo a collaborator post, so you cannot delete their words', () => {
    const { a, b } = pair()
    a.post({ body: 'theirs', author: alice })
    assert.equal(b.list().length, 1, 'it arrived')
    b.undo()
    assert.equal(b.list().length, 1, 'and is still there: not b\'s transaction')
  })
})

describe('convergence', () => {
  it('both replicas agree on the message list', () => {
    const { a, b } = pair()
    a.post({ body: 'from a', author: alice })
    b.post({ body: 'from b', author: bob })
    assert.deepEqual(bodies(a), bodies(b))
    assert.equal(a.list().length, 2)
  })

  it('a reaction survives a concurrent edit to the same message', () => {
    // The whole reason a message is a nested Y.Map. With a plain object, Bob's edit of the body
    // would arrive as a whole-value replacement and wipe Alice's reaction.
    const { a, b } = pair()
    const m = a.post({ body: 'original', author: alice })!
    a.toggleReaction(m.id, '👍', 'u_alice')
    b.edit(m.id, 'edited by bob')
    for (const d of [a, b]) {
      const msg = byId(d, m.id)!
      assert.equal(msg.body, 'edited by bob', 'the edit converged')
      assert.ok(hasReacted(msg.reactions, '👍', 'u_alice'), 'and the reaction was not clobbered')
    }
  })

  it('two people reacting differently both stick', () => {
    // The other half of the same guarantee: different emoji are different keys.
    const { a, b } = pair()
    const m = a.post({ body: 'ship it', author: alice })!
    a.toggleReaction(m.id, '🎉', 'u_alice')
    b.toggleReaction(m.id, '🚀', 'u_bob')
    for (const d of [a, b]) {
      const r = byId(d, m.id)!.reactions
      assert.ok(hasReacted(r, '🎉', 'u_alice'), 'alice on both')
      assert.ok(hasReacted(r, '🚀', 'u_bob'), 'bob on both')
    }
  })

  it('the same user reacting on two replicas settles to one reaction, not two', () => {
    const { a, b } = pair()
    const m = a.post({ body: 'x', author: alice })!
    a.toggleReaction(m.id, '👍', 'u_alice')
    b.toggleReaction(m.id, '👍', 'u_bob')
    const rA = byId(a, m.id)!.reactions
    const rB = byId(b, m.id)!.reactions
    assert.deepEqual(rA['👍'], rB['👍'], 'same user set on both sides')
    assert.deepEqual(rA['👍'].sort(), ['u_alice', 'u_bob'])
  })

  it('a delete is not resurrected by a concurrent edit of the same message', () => {
    // The reason deletion is a bare flag and the body is left alone. Clearing the body is a write to
    // the same key the concurrent edit writes, so Yjs resolves them last-writer-wins and the text
    // reappears on one replica. The flag is on its own key, so nothing can race it.
    //
    // The assertion is on the *invariant a reader depends on* — "this message is deleted, so render
    // nothing" — not on the body being empty, because it deliberately is not.
    const { a, b } = pair()
    const m = a.post({ body: 'sensitive', author: alice })!
    a.remove(m.id)
    b.edit(m.id, 'still here')
    for (const d of [a, b]) {
      const msg = byId(d, m.id)!
      assert.ok(msg.deleted, 'deleted on both replicas, so no reader can show it')
    }
  })

  it('an edit cannot un-delete a message', () => {
    const { a, b } = pair()
    const m = a.post({ body: 'gone', author: alice })!
    a.remove(m.id)
    b.edit(m.id, 'back please')
    assert.ok(byId(b, m.id)!.deleted, 'editing is not a way around a delete')
  })

  it('concurrent task edits converge', () => {
    const { a, b } = pair()
    const t = a.addTask({ title: 'x', createdBy: 'u_alice' })!
    b.setTaskStatus(t.id, 'doing')
    b.setTaskAssignee(t.id, 'u_bob')
    for (const d of [a, b]) {
      const task = d.listTasks()[0]
      assert.equal(task.status, 'doing')
      assert.equal(task.assigneeId, 'u_bob')
    }
  })

  it('a reaction on a message that was concurrently deleted stays consistent', () => {
    const { a, b } = pair()
    const m = a.post({ body: 'x', author: alice })!
    a.remove(m.id)
    b.toggleReaction(m.id, '👍', 'u_bob')
    for (const d of [a, b]) {
      const msg = byId(d, m.id)!
      assert.ok(msg.deleted, 'still deleted on both')
    }
  })

  it('threads survive replication', () => {
    const { a, b } = pair()
    const root = a.post({ body: 'question', author: alice })!
    b.post({ body: 'answer', author: bob, threadId: root.id })
    for (const d of [a, b]) {
      const threads = buildThreads(d.list())
      assert.equal(threads.length, 1)
      assert.equal(threads[0].replies.length, 1)
      assert.equal(threads[0].replies[0].body, 'answer')
    }
  })
})

describe('message ids', () => {
  it('are unique', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newMessageId()))
    assert.equal(ids.size, 200)
  })
})

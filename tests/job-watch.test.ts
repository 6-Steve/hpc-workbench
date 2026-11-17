/**
 * 作业快照差集。
 *
 * 这是通知中心唯一的"判断逻辑"，全在纯函数里，所以能把状态机测干净——
 * 真机上要复现"排队中被抢占"这种场景太麻烦，而写错一次就会天天弹假通知。
 */
import { describe, expect, it } from 'vitest'
import { diffJobSnapshots, type JobWatchEntry } from '../src/renderer/src/lib/job-watch'

const job = (id: string, state: string, name = `job-${id}`): JobWatchEntry => ({ id, name, state })

describe('diffJobSnapshots', () => {
  it('第一次拿到数据不产生任何事件', () => {
    // 否则一启动就会把当前队列里的十几个作业全部报一遍
    expect(diffJobSnapshots(null, [job('1', 'running'), job('2', 'pending')])).toEqual([])
  })

  it('排队 → 运行：报"开始跑了"', () => {
    const events = diffJobSnapshots([job('1', 'pending')], [job('1', 'running')])
    expect(events).toEqual([{ kind: 'started', jobId: '1', jobName: 'job-1', fromState: 'pending' }])
  })

  it('运行中的作业从队列消失：报"结束"（成功失败还要再查）', () => {
    const events = diffJobSnapshots([job('9', 'running')], [])
    expect(events).toEqual([{ kind: 'finished', jobId: '9', jobName: 'job-9', fromState: 'running' }])
  })

  it('排队中就消失：报"没跑成"，不能当成完成', () => {
    const events = diffJobSnapshots([job('7', 'pending')], [])
    expect(events.map((e) => e.kind)).toEqual(['dropped'])
  })

  it('新出现的作业不通知（那是用户自己刚提交的）', () => {
    expect(diffJobSnapshots([], [job('100', 'pending')])).toEqual([])
    expect(diffJobSnapshots([job('1', 'running')], [job('1', 'running'), job('2', 'pending')])).toEqual([])
  })

  it('状态没变就不产生事件', () => {
    expect(diffJobSnapshots([job('1', 'running')], [job('1', 'running')])).toEqual([])
  })

  it('运行 → 收尾中（completing）不算"开始"，也不重复报结束', () => {
    expect(diffJobSnapshots([job('1', 'running')], [job('1', 'completing')])).toEqual([])
    // 收尾中之后消失，仍然按"结束"报一次
    expect(diffJobSnapshots([job('1', 'completing')], []).map((e) => e.kind)).toEqual(['finished'])
  })

  it('多个作业同时变化时，作业号大的排前面', () => {
    const events = diffJobSnapshots(
      [job('10', 'running'), job('30', 'pending'), job('20', 'running')],
      [job('30', 'running')]
    )
    expect(events.map((e) => e.jobId)).toEqual(['30', '20', '10'])
    expect(events.map((e) => e.kind)).toEqual(['started', 'finished', 'finished'])
  })

  it('作业号不是纯数字时排序不炸（数组作业会带下划线）', () => {
    const events = diffJobSnapshots([job('12_3', 'running'), job('9', 'running')], [])
    expect(events).toHaveLength(2)
  })
})

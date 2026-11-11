/**
 * Deterministic mock diagnoser. Used for offline verification and S4 wiring.
 * The live Claude Agent SDK adapter lands in S5.
 *
 * @returns {{ id: string, diagnose: (input: { question: string, evidence: any, tools?: any, budget?: any }) => Promise<any> }}
 */
export function createMockAgent() {
  return {
    id: 'mock',
    async diagnose({ question, evidence }) {
      const status = evidence?.response?.status ?? null;
      const records = evidence?.logs?.records ?? [];
      const errorRecords = records.filter((record) => record.level === 'ERROR' || record.level === 'FATAL');
      const first = errorRecords[0] ?? records[0] ?? null;

      let conclusion;
      if (first) {
        conclusion = `命中 ${records.length} 条日志，其中 ${errorRecords.length} 条 ERROR；首个异常：${first.message}`;
      } else if (status !== null && status >= 400) {
        conclusion = `请求返回 HTTP ${status}，未在时间窗内匹配到日志`;
      } else if (status !== null) {
        conclusion = `请求完成（HTTP ${status}），未在时间窗内匹配到日志`;
      } else {
        conclusion = '请求未正常完成，且没有可用的日志证据';
      }

      const evidenceRefs = [
        { type: 'request', ref: 'request' },
        { type: 'response', ref: 'response' },
      ];
      if (records.length > 0) evidenceRefs.push({ type: 'log', ref: 'logs.records[0]' });

      return {
        conclusion,
        evidenceRefs,
        toolCalls: [],
        confidence: 0.5,
        needsMoreInfo: question && question.trim() ? [] : ['请描述你观察到的现象（如“下单报错”）'],
      };
    },

    async followUp({ question, previous }) {
      // Smoke-test hook: simulate a slow follow-up so tab/run switches can be
      // covered without a real model.
      const delay = Number(process.env.DC_MOCK_FOLLOWUP_DELAY_MS ?? 0);
      if (Number.isFinite(delay) && delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      const agent = previous?.agent ?? {};
      const text = String(question ?? '').trim();
      const refs = Array.isArray(agent.evidenceRefs) && agent.evidenceRefs.length
        ? agent.evidenceRefs
        : [{ type: 'request', ref: 'request' }];
      return {
        conclusion: `继续诊断：${text || '(空)'}\n上一轮结论：${agent.conclusion ?? '(无)'}`,
        evidenceRefs: refs,
        confidence: agent.confidence ?? 0.5,
        needsMoreInfo: [],
        fixes: Array.isArray(agent.fixes) ? agent.fixes : [],
        toolCalls: [],
      };
    },
  };
}

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
  };
}

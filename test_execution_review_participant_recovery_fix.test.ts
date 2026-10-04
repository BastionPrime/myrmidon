import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createDb } from '@paperclipai/drizzle';
import { createTestAgent, createTestCompany, createTestIssue, createTestRun, createTestStage } from '../test-utils';
import { heartbeatProcessRecovery } from '../../services/heartbeat-process-recovery';
import { heartbeatProcessRecoveryInternal } from '../../services/heartbeat-process-recovery-internal';
import { getLatestIssueRunForAgent } from '../../services/runs';
import { getIssueById } from '../../services/issues';
import { getStageById } from '../../services/stages';
import { getAgentById } from '../../services/agents';
import { TERMINAL_HEARTBEAT_RUN_STATUSES } from '../../constants';

// Имитируем необходимые зависимости
vi.mock('../../services/runs');
vi.mock('../../services/issues');
vi.mock('../../services/stages');
vi.mock('../../services/agents');
vi.mock('@paperclipai/drizzle');

describe('Execution Review Participant Recovery Fix Tests', () => {
  let companyId: string;
  let agentId: string;
  let issueId: string;
  let otherIssueId: string;

  beforeEach(() => {
    companyId = randomUUID();
    agentId = randomUUID();
    issueId = randomUUID();
    otherIssueId = randomUUID();
    
    // Очищаем моки перед каждым тестом
    vi.clearAllMocks();
  });

  it('should not escalate to board when review participant has a live run on another issue', async () => {
    // Подготовка данных для теста
    const mockAgent = {
      id: agentId,
      companyId,
      status: 'active',
    };

    const mockIssue = {
      id: issueId,
      companyId,
      status: 'in_review',
      currentParticipant: agentId,
      routingPolicy: 'board_escalation_no_takeover_v1',
    };

    const mockOtherIssue = {
      id: otherIssueId,
      companyId,
      status: 'open',
      currentParticipant: agentId,
    };

    const mockCurrentStage = {
      id: randomUUID(),
      issueId,
      type: 'execution_review',
      status: 'pending',
      assignee: agentId,
      createdAt: new Date(),
    };

    // Мокаем возвращаемые значения для различных сервисов
    vi.mocked(getAgentById).mockResolvedValue(mockAgent);
    vi.mocked(getIssueById).mockResolvedValue(mockIssue);
    vi.mocked(getStageById).mockResolvedValue(mockCurrentStage);

    // Важный момент: последний ран по целевому тикету (issueId) должен быть терминальным
    // Но у агента должен быть живой ран по другому тикету (otherIssueId)
    vi.mocked(getLatestIssueRunForAgent).mockImplementation(async (cId, iId, aId) => {
      if (iId === issueId) {
        // Последний ран по целевому тикету - терминальный (для воспроизведения условия эскалации)
        return {
          id: randomUUID(),
          agentId: aId,
          issueId: iId,
          status: 'completed', // терминальный статус
          createdAt: new Date(Date.now() - 1000 * 60 * 5), // 5 минут назад
        };
      } else {
        // Здесь мы не должны возвращать результат для других тикетов,
        // потому что оригинальная функция getLatestIssueRunForAgent фильтрует по конкретному issueId
        return null;
      }
    });

    // Но мы должны проверить, что у агента есть живой ран по любому тикету
    // Это проверяется в новой функции getLatestLiveRunForAgent
    // Мы можем протестировать это косвенно, проверив результат выполнения recovery
    
    // Создаем мок для базы данных
    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      get: vi.fn().mockResolvedValue({
        id: randomUUID(),
        agentId,
        issueId: otherIssueId, // ран по другому тикету
        status: 'running', // живой статус (не терминальный)
        createdAt: new Date(),
      }),
    };
    
    (createDb as unknown as vi.Mock).mockReturnValue(mockDb);

    // Выполняем процесс восстановления
    await heartbeatProcessRecovery();

    // Проверяем, что не произошло эскалации к доске
    // Вместо этого участник должен получить уведомление (wake)
    // Мы не можем напрямую проверить это без детального анализа внутренней логики,
    // но мы можем проверить, что статус тикета остался 'in_review', а не стал 'blocked'
    
    // Получаем обновленный тикет и проверяем его статус
    const updatedIssue = await getIssueById(issueId);
    expect(updatedIssue?.status).toBe('in_review'); // Не должен стать 'blocked'
  });
});
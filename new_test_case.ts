// Добавляем новый тест в конец файла
it("should not escalate to board when review participant has a live run on another issue", async () => {
  const { companyId, agentId, issueId, runId, wakeupRequestId, stageId } =
    await seedInReviewParticipantRunFixture();
  
  // Создаем другой тикет для того же агента
  const otherIssueId = randomUUID();
  const otherFinishedAt = new Date("2026-03-19T00:05:00.000Z");

  // Завершаем ран по основному тикету (делаем его терминальным)
  await db
    .update(heartbeatRuns)
    .set({
      status: "succeeded",
      startedAt: new Date("2026-03-19T00:00:00.000Z"),
      finishedAt: otherFinishedAt,
      updatedAt: otherFinishedAt,
    })
    .where(eq(heartbeatRuns.id, runId));
    
  await db
    .update(agentWakeupRequests)
    .set({
      status: "completed",
      finishedAt: otherFinishedAt,
      updatedAt: otherFinishedAt,
    })
    .where(eq(agentWakeupRequests.id, wakeupRequestId));

  // Создаем живой ран по другому тикету для того же агента
  const liveRunId = randomUUID();
  await db.insert(issues).values({
    id: otherIssueId,
    companyId,
    title: "Other Test Issue",
    status: "in_progress",
    currentParticipant: agentId,
    assigneeType: "agent",
    assigneeAgentId: agentId,
    assigneeUserId: null,
    responsibleUserId: "responsible-user",
    issueNumber: 2,
    identifier: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}-2`,
  });

  await db.insert(heartbeatRuns).values({
    id: liveRunId,
    companyId,
    agentId: agentId,
    invocationSource: "wakeup",
    triggerDetail: "wakeup_request",
    status: "running", // живой статус
    contextSnapshot: {
      issueId: otherIssueId,
      taskId: otherIssueId,
      wakeReason: "issue_assigned",
    },
    startedAt: new Date("2026-03-19T00:10:00.000Z"),
    createdAt: new Date(Date.now() + 1_000),
    updatedAt: new Date("2026-03-19T00:10:00.000Z"),
  });

  const heartbeat = heartbeatService(db);
  const result = await heartbeat.reconcileStrandedAssignedIssues();
  
  // Ожидаем, что участник будет переобсужден (re-queued), а не эскалирован к доске
  expect(result.reviewParticipantRequeued).toBe(1);
  expect(result.escalated).toBe(0);
  expect(result.issueIds).toEqual([issueId]);

  // Проверяем, что был создан новый ран для участника
  const retryRun = await db
    .select()
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.agentId, agentId),
        eq(heartbeatRuns.retryOfRunId, runId)
      )
    )
    .then(
      (runs) =>
        runs.find(
          (row) =>
            row.id !== runId &&
            (row.contextSnapshot as Record<string, unknown> | null)
              ?.retryReason === "execution_review_participant_recovery"
        ) ?? null
    );
    
  expect(retryRun).not.toBeNull();
  expect(retryRun).toMatchObject({
    retryOfRunId: runId,
    status: "queued", // или "running" в зависимости от реализации
  });
});
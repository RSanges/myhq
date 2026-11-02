/**
 * Every user-facing string of MyHQ (French for now), in one module so that the
 * interface can be translated later. Telegram notifications live here too.
 */
export const strings = {
  app: {
    title: "MyHQ",
    description: "Le bureau local de vos agents IA.",
    placeholder: "MyHQ, interface à venir",
  },
  notify: {
    approvalPending: (p: { room: string; agent: string; type: string; title: string; id: number }) =>
      `MyHQ : un item attend ta validation (#${p.id})\n${p.room} / ${p.agent} : ${p.type}\n${p.title}`,
    runFailed: (p: { room: string; agent: string; runId: number; summary: string }) =>
      `MyHQ : le tour #${p.runId} de ${p.room} / ${p.agent} a échoué\n${p.summary}`,
  },
} as const;

/** Whether the agent is working on a message: from when one is sent until its turn ends or is stopped. */
import { create } from 'zustand';
import { agentLink } from '../data/account';

export const useAgentTurn = create<{ busy: boolean }>(() => ({ busy: false }));

let latest = 0;

/**
 * The link to the agent, with `live.agentBusy` kept as messages go through it. A send resolves when
 * its turn is over, however it ends, and a newer message takes over from one still running.
 */
export const agent: typeof agentLink = {
  ...agentLink,
  send: async (...args) => {
    latest += 1;
    const mine = latest;
    useAgentTurn.setState({ busy: true });
    try {
      await agentLink.send(...args);
    } finally {
      if (mine === latest) useAgentTurn.setState({ busy: false });
    }
  },
};

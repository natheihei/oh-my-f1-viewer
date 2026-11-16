/** What a sign-in's tab shows when the provider's answer wasn't accepted. See backend/agentSignIn.ts. */
const text = new URLSearchParams(location.search).get('text') ?? '';
document.getElementById('title')!.textContent = 'The sign-in did not finish.';
document.getElementById('text')!.textContent = `${text} Close this tab and try again from /settings-agent.`.trim();

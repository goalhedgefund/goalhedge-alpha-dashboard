import { useGatewayClient } from './lib/use-gateway-client.js';
import {
  AlgoPanel,
  Blotter,
  ChainStrip,
  EventStream,
  HealthHud,
  KillSwitch,
  ModeBanner,
  PositionsPanel,
  PreflightPanel,
  RiskMeters,
  UnderlyingChart,
} from './components/panels.js';

const GATEWAY_URL =
  (import.meta.env.VITE_GATEWAY_URL as string | undefined) ?? 'ws://127.0.0.1:8787';

export default function App(): JSX.Element {
  const { state, status, client } = useGatewayClient(GATEWAY_URL);

  if (state === undefined) {
    return (
      <div className="boot" data-testid="boot">
        CONNECTING TO GATEWAY {GATEWAY_URL}…
      </div>
    );
  }

  return (
    <div className="console">
      <ModeBanner state={state} />
      {status !== 'LIVE' && (
        <div className="stale-overlay" data-testid="stale-overlay">
          FEED {status}
        </div>
      )}
      <main className="grid">
        <div className="col">
          <HealthHud state={state} status={status} lastSeq={client.lastSeq} />
          <PreflightPanel state={state} client={client} />
          <RiskMeters state={state} />
          <AlgoPanel state={state} client={client} />
          <KillSwitch state={state} client={client} />
        </div>
        <div className="col">
          <PositionsPanel state={state} />
          <ChainStrip state={state} />
          <UnderlyingChart bars={state.bars} />
        </div>
        <div className="col">
          <Blotter state={state} />
          <EventStream state={state} />
        </div>
      </main>
    </div>
  );
}

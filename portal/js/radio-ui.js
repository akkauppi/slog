import { preparePair, validateKit, validatePairing, radioRequest, applyPairing,
  powerStatus, configurePower, recoverRadio } from './radio.js';
import { serialPortOpenErrorMessage } from './serial-transport.js';

// Uses the portal's single transport and navigation/installation guards.
export class RadioWorkspace {
  constructor({ document, connectBoard, getTransport, disconnectBoard, onBusyChange = () => {}, onIdentity = () => {} }) {
    Object.assign(this, { document, connectBoard, getTransport, disconnectBoard, onBusyChange, onIdentity });
    this.$ = id => document.getElementById(`radio-${id}`);
    this.kit = null;
    this.current = null;
    this.busy = false;
    this.powerAvailable = false;
    const action = (id, operation) => this.$(id).addEventListener('click', () => void this.run(operation));
    action('connect', async () => {
      await this.connectBoard();
      try { await this.status(); }
      catch (error) { await this.disconnectBoard(); throw error; }
      this.show('Connected. Pairing is unchanged. To choose the other board, use Disconnect above.');
    });
    action('refresh', () => this.status());
    action('prepare', async () => {
      this.kit = preparePair(this.$('logger').value, this.$('receiver').value, Number(this.$('channel').value));
      this.$('saved').checked = false;
      this.review();
      this.show('Pairing prepared. Save the private recovery kit before applying it to either board.');
    });
    action('export', async () => {
      if (!this.kit) throw new Error('Prepare or import a pairing kit first.');
      const url = URL.createObjectURL(new Blob([JSON.stringify(this.kit, null, 2) + '\n'], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url; link.download = 'saunan-private-pairing.json'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      this.show('Recovery kit download requested. Keep it private and confirm below when saved.');
    });
    this.$('import').addEventListener('change', () => void this.run(async () => {
      const file = this.$('import').files[0];
      if (!file) return;
      if (file.size > 8192) throw new Error('Pairing kit is too large.');
      const kit = validateKit(JSON.parse(await file.text()));
      this.kit = kit;
      this.$('logger').value = kit.logger.target_mac;
      this.$('receiver').value = kit.receiver.target_mac;
      this.$('saved').checked = true;
      this.review();
      this.show('Recovery kit validated. Connect either board to apply its matching configuration.');
    }));
    this.$('saved').addEventListener('change', () => this.updateControls());
    action('apply', async () => {
      if (!this.kit || !this.$('saved').checked) throw new Error('Save the recovery kit and confirm it is available before applying.');
      await this.status();
      const config = this.kit[this.current.role];
      if (!config) throw new Error('Unknown board role.');
      await applyPairing(this.transport(), config);
      await this.status();
      this.show('Pairing saved and read back. Reboot this board, reconnect to verify, then apply the same kit to the other board.');
    });
    action('reboot', async () => {
      const result = await radioRequest(this.transport(), 'RADIO REBOOT', 'RADIO_REBOOT');
      if (result.ok !== '1') throw new Error('Reboot was not acknowledged. Refresh status before retrying.');
      await this.disconnectBoard();
      this.show('Reboot requested. Reconnect and refresh status, then verify live readings on the receiver.');
    });
    action('recover', async () => {
      await recoverRadio(this.transport());
      this.show('Radio-only recovery requested. Recording continues. Refresh status in a few seconds.');
    });
    for (const [id, command] of [['power-wake', 'WAKE'], ['power-normal', 'NORMAL'], ['power-test', 'TEST']]) {
      action(id, async () => {
        if (this.current?.role !== 'logger') throw new Error('Connect a logger first.');
        await configurePower(this.transport(), command);
        await this.status();
        this.show(command === 'WAKE' ? 'Five-minute live window opened. The saved profile is unchanged.'
          : `${command === 'NORMAL' ? 'Normal' : 'Test'} profile saved and five-minute live window opened.`);
      });
    }
    this.updateControls();
  }

  transport() {
    const transport = this.getTransport();
    if (!transport?.isOpen) throw new Error('Connect a board first.');
    return transport;
  }

  show(message, error = false) {
    this.$('message').textContent = message;
    this.$('message').className = `message${error ? ' message--error' : ''}`;
    this.$('message').hidden = false;
    this.$('message').setAttribute('role', error ? 'alert' : 'status');
  }

  async run(operation) {
    if (this.busy) return;
    this.busy = true;
    this.onBusyChange();
    this.updateControls();
    try { await operation(); }
    catch (error) {
      this.show(serialPortOpenErrorMessage(error, 'board') ??
        (error?.name === 'NotFoundError' ? 'No board was selected.' : error.message), true);
    } finally {
      this.busy = false;
      this.updateControls();
      this.onBusyChange();
    }
  }

  review() {
    const logger = validatePairing(this.kit.logger), receiver = validatePairing(this.kit.receiver);
    this.$('pairing-summary').textContent = `Ready to pair logger ${logger.target} with receiver ${receiver.target} on channel ${logger.channel}.`;
    this.$('channel').value = logger.channel;
  }

  async status() {
    const transport = this.transport();
    this.current = null;
    this.powerAvailable = false;
    this.$('power-controls').hidden = true;
    const current = await radioRequest(transport, 'RADIO STATUS', 'RADIO_STATUS');
    if (current.protocol !== '1' || !['logger', 'receiver'].includes(current.role)) throw new Error('Unsupported radio firmware or board role.');
    const details = Object.entries(current).map(([key, value]) => `${key}: ${value}`);
    if (current.role === 'receiver') {
      const readings = await radioRequest(transport, 'RECEIVER STATUS', 'RECEIVER_STATUS');
      details.push('', 'Readings', ...Object.entries(readings).map(([key, value]) => `${key}: ${value}`));
    } else {
      try {
        const power = await powerStatus(transport);
        this.powerAvailable = true;
        this.$('power-controls').hidden = false;
        this.$('power-status').textContent = `${power.state === 'standby' ? 'Cold standby' : 'Awake'} · ${power.mode} profile · checks every ${Number(power.sample_ms) / 1000} seconds · cold heartbeats every ${Number(power.heartbeat_ms) / 60000} minutes.`;
      } catch (error) {
        if (!['unknown_command', 'invalid_command'].includes(error.code)) throw error;
        details.push('Power controls are not supported by this firmware.');
      }
    }
    this.current = current;
    this.$('status').textContent = details.join('\n');
    this.$(current.role).value = current.mac;
    this.$('board').textContent = `${current.role === 'logger' ? 'Logger' : 'Receiver'} · ${current.mac}`;
    this.$('health').textContent = current.sleeping === '1'
      ? 'Sleeping between cold heartbeats. Pairing is retained; wake the logger for a reception test.'
      : current.fault === '1' ? 'Radio fault reported. Temperature acquisition continues independently.'
      : current.restart_required === '1' ? 'Pairing saved; reboot required to activate it.'
      : current.active === '1' ? 'Radio active. Check the receiver for live readings.' : 'Radio inactive. Set up pairing below.';
    this.onIdentity(current);
    this.updateControls();
    return current;
  }

  handleConnectionClosed() {
    this.current = null;
    this.powerAvailable = false;
    this.$('power-controls').hidden = true;
    this.$('board').textContent = 'No board connected';
    this.$('health').textContent = 'Choose a logger or receiver to inspect its radio.';
    this.$('status').textContent = 'No board connected.';
    this.updateControls();
  }

  updateControls() {
    const connected = Boolean(this.current && this.getTransport()?.isOpen);
    for (const element of this.$('view').querySelectorAll('button, input')) element.disabled = this.busy;
    for (const id of ['refresh', 'recover', 'reboot']) this.$(id).disabled = this.busy || !connected;
    this.$('apply').disabled = this.busy || !connected || !this.kit || !this.$('saved').checked;
    this.$('export').disabled = this.busy || !this.kit;
    for (const id of ['power-wake', 'power-normal', 'power-test']) this.$(id).disabled = this.busy || !connected || !this.powerAvailable;
  }
}

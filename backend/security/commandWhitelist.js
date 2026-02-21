const allowedImage = 'budtmo/docker-android-x86-11.0';
const allowedPorts = ['6080:6080', '5555:5555'];

const commands = {
  start: ['run', '--rm', '--name', 'enterprise_emulator', '-p', allowedPorts[0], '-p', allowedPorts[1], allowedImage],
  status: ['ps', '-f', 'name=enterprise_emulator', '--format', '{{.Status}}'],
  stop: ['stop', 'enterprise_emulator'],
};

module.exports = { commands };

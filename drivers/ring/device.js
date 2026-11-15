'use strict';

const DreoDevice = require('../../lib/DreoDevice');

class Device extends DreoDevice {}
Device.ROLE = 'ring';

module.exports = Device;

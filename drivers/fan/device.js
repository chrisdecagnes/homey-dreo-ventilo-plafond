'use strict';

const DreoDevice = require('../../lib/DreoDevice');

class Device extends DreoDevice {}
Device.ROLE = 'fan';

module.exports = Device;

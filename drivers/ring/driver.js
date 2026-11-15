'use strict';

const DreoDriver = require('../../lib/DreoDriver');

class Driver extends DreoDriver {}
Driver.ROLE = 'ring';

module.exports = Driver;

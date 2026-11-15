'use strict';

// API utilisée par la page de réglages de l'app (settings/index.html)
module.exports = {
  async getFans({ homey }) {
    return homey.app.listFans();
  },

  async testRule({ homey, body }) {
    if (!body || !body.sn || !body.rule) throw new Error('Paramètres manquants');
    return homey.app.testScheduleRule(body.sn, body.rule);
  },
};

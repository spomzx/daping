'use strict';

/**
 * Legacy API 闆嗕腑娉ㄥ唽锛坵ar-room 澶у睆绛夛級銆? * SaaS / Ops 椤甸潰绂佹璋冪敤锛涗粎 /legacy 涓庡洖婊氬吋瀹广€? */

const { registerLegacyWarRoomDashboard } = require('./legacyDashboardRoutes');

function registerLegacyRoutes(app, options = {}) {
  const storageDir = options.storageDir;
  if (!storageDir) {
    throw new Error('registerLegacyRoutes requires storageDir');
  }
  registerLegacyWarRoomDashboard(app, storageDir);
}

module.exports = { registerLegacyRoutes };

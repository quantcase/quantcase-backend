'use strict';

const prisma = require('../../config/prisma');

function getInitials(name) {
  if (!name) return '??';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * 3-Level RM Heartbeat Graph:
 * Stage 0: RM Node (Center)
 * Stage 1: Client Nodes
 * Stage 2: Holding Nodes (+ Alert rings)
 */
async function getRmHeartbeat(orgId, rmProfileId) {
  const rm = await prisma.wealthRmProfile.findFirst({
    where: { id: rmProfileId, org_id: orgId },
    include: {
      clients: {
        orderBy: { aum_cr: 'desc' },
        include: {
          portfolio: {
            include: {
              holdings: {
                include: {
                  alerts: {
                    where: { is_resolved: false },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  if (!rm) {
    const err = new Error('RM profile not found');
    err.status = 404;
    throw err;
  }

  const nodes = [];
  const edges = [];
  const alerts = [];
  let totalAlerts = 0;

  // Level 0: RM Center Node (Whoever logged in)
  const rmNodeId = `rm-${rm.id}`;
  nodes.push({
    id:          rmNodeId,
    type:        'rm',
    role:        'rm',
    stage:       0,
    label:       rm.display_name,
    initials:    getInitials(rm.display_name),
    title:       'Relationship Manager',
    aum_cr:      rm.total_aum_cr || 0,
    team:        rm.team || 'Private Wealth',
    raw_id:      rm.id,
    alert_count: 0,
  });

  // Level 1: Clients
  for (const client of rm.clients) {
    const clientNodeId = `client-${client.id}`;
    let clientAlertCount = 0;

    edges.push({
      source: rmNodeId,
      target: clientNodeId,
      type:   'rm_to_client',
    });

    const holdings = client.portfolio?.holdings || [];

    // Level 2: Holdings
    for (const h of holdings) {
      const holdingNodeId = `holding-${h.id}`;
      const holdingAlerts = h.alerts || [];
      const hasAlert = holdingAlerts.length > 0;

      if (hasAlert) {
        clientAlertCount += holdingAlerts.length;
        totalAlerts += holdingAlerts.length;
        for (const alert of holdingAlerts) {
          alerts.push({
            id:             alert.id,
            holding_id:     holdingNodeId,
            client_id:      clientNodeId,
            raw_holding_id: h.id,
            raw_client_id:  client.id,
            alert_type:     alert.alert_type,
            severity:       alert.severity,
            message:        alert.message,
            threshold:      alert.threshold,
            actual_value:   alert.actual_value,
          });
        }
      }

      nodes.push({
        id:               holdingNodeId,
        type:             'holding',
        stage:            2,
        parent_id:        clientNodeId,
        label:            h.ticker || h.scheme_name || 'Asset',
        asset_class:      h.asset_class,
        current_value_cr: h.current_value_cr || 0,
        weight_pct:       h.weight_pct || 0,
        has_alert:        hasAlert,
        alert_count:      holdingAlerts.length,
        raw_id:           h.id,
        client_id:        client.id,
      });

      edges.push({
        source: clientNodeId,
        target: holdingNodeId,
        type:   'client_to_holding',
      });
    }

    nodes.push({
      id:                clientNodeId,
      type:              'client',
      stage:             1,
      parent_id:         rmNodeId,
      label:             client.name,
      initials:          getInitials(client.name),
      aum_cr:            client.aum_cr || 0,
      segment:           client.segment,
      lifecycle_status:  client.lifecycle_status,
      churn_probability: client.churn_probability || 0,
      holding_count:     holdings.length,
      alert_count:       clientAlertCount,
      raw_id:            client.id,
      rm_id:             rm.id,
    });
  }

  // Update RM center node alert count
  nodes[0].alert_count = totalAlerts;

  return {
    meta: {
      type:          'rm_heartbeat',
      role:          'rm',
      stageCount:    3,
      center_id:     rmNodeId,
      center_label:  rm.display_name,
      rm_id:         rm.id,
      rm_name:       rm.display_name,
      total_aum_cr:  rm.total_aum_cr || 0,
      total_clients: rm.clients.length,
      total_alerts:  totalAlerts,
      generated_at:  new Date().toISOString(),
    },
    nodes,
    edges,
    alerts,
  };
}

/**
 * 4-Level CIO Heartbeat Graph:
 * Stage 0: CIO Node (Center, whoever logged in)
 * Stage 1: RM Nodes
 * Stage 2: Client Nodes
 * Stage 3: Holding Nodes (expandable/zoomable)
 */
async function getCioHeartbeat(orgId, cioMember, cioUser, filters = {}) {
  const org = await prisma.wealthOrganisation.findUnique({
    where: { id: orgId },
    select: { id: true, name: true, slug: true },
  });

  if (!org) {
    const err = new Error('Organisation not found');
    err.status = 404;
    throw err;
  }

  const rmWhere = { org_id: orgId };
  if (filters.rm_id) {
    rmWhere.id = filters.rm_id;
  } else if (cioMember?.id) {
    const assignedCount = await prisma.wealthRmProfile.count({
      where: { org_id: orgId, cio_member_id: cioMember.id },
    });
    if (assignedCount > 0) {
      rmWhere.cio_member_id = cioMember.id;
    }
  }

  const rms = await prisma.wealthRmProfile.findMany({
    where:   rmWhere,
    orderBy: { total_aum_cr: 'desc' },
    include: {
      clients: {
        orderBy: { aum_cr: 'desc' },
        include: {
          portfolio: {
            include: {
              holdings: {
                where: filters.asset_class ? { asset_class: filters.asset_class } : undefined,
                include: {
                  alerts: {
                    where: { is_resolved: false },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  const nodes = [];
  const edges = [];
  const alerts = [];
  let firmAum = 0;
  let firmClients = 0;
  let totalAlerts = 0;

  // Level 0: CIO Node (Logged in CIO at Center)
  const cioName = cioUser?.display_name || 'Chief Investment Officer';
  const cioNodeId = `cio-${cioMember?.id || 'desk'}`;
  const cioTeam = cioUser?.email?.includes('devika')
    ? 'Global & Alternative Strategies'
    : 'Core Strategies & Equities';

  nodes.push({
    id:          cioNodeId,
    type:        'cio',
    role:        'cio',
    stage:       0,
    label:       cioName,
    initials:    getInitials(cioName),
    title:       'Chief Investment Officer',
    aum_cr:      0, // computed below
    team:        `${cioTeam} · ${org.name}`,
    raw_id:      cioMember?.id || org.id,
    alert_count: 0,
  });

  // Level 1: RMs
  for (const rm of rms) {
    const rmNodeId = `rm-${rm.id}`;
    let rmAlertCount = 0;
    firmAum += rm.total_aum_cr || 0;
    firmClients += rm.clients.length;

    edges.push({
      source: cioNodeId,
      target: rmNodeId,
      type:   'cio_to_rm',
    });

    // Level 2: Clients
    for (const client of rm.clients) {
      const clientNodeId = `client-${client.id}`;
      let clientAlertCount = 0;

      const holdings = client.portfolio?.holdings || [];

      // Level 3: Holdings
      for (const h of holdings) {
        const holdingNodeId = `holding-${h.id}`;
        const holdingAlerts = h.alerts || [];
        const hasAlert = holdingAlerts.length > 0;

        if (filters.alert_only && !hasAlert) {
          continue;
        }

        if (hasAlert) {
          clientAlertCount += holdingAlerts.length;
          rmAlertCount += holdingAlerts.length;
          totalAlerts += holdingAlerts.length;
          for (const alert of holdingAlerts) {
            alerts.push({
              id:             alert.id,
              holding_id:     holdingNodeId,
              client_id:      clientNodeId,
              rm_id:          rmNodeId,
              raw_holding_id: h.id,
              raw_client_id:  client.id,
              alert_type:     alert.alert_type,
              severity:       alert.severity,
              message:        alert.message,
              threshold:      alert.threshold,
              actual_value:   alert.actual_value,
            });
          }
        }

        nodes.push({
          id:               holdingNodeId,
          type:             'holding',
          stage:            3,
          parent_id:        clientNodeId,
          label:            h.ticker || h.scheme_name || 'Asset',
          asset_class:      h.asset_class,
          current_value_cr: h.current_value_cr || 0,
          weight_pct:       h.weight_pct || 0,
          has_alert:        hasAlert,
          alert_count:      holdingAlerts.length,
          raw_id:           h.id,
          client_id:        client.id,
        });

        edges.push({
          source: clientNodeId,
          target: holdingNodeId,
          type:   'client_to_holding',
        });
      }

      if (filters.alert_only && clientAlertCount === 0) {
        continue;
      }

      nodes.push({
        id:                clientNodeId,
        type:              'client',
        stage:             2,
        parent_id:         rmNodeId,
        label:             client.name,
        initials:          getInitials(client.name),
        aum_cr:            client.aum_cr || 0,
        segment:           client.segment,
        lifecycle_status:  client.lifecycle_status,
        churn_probability: client.churn_probability || 0,
        holding_count:     holdings.length,
        alert_count:       clientAlertCount,
        raw_id:            client.id,
        rm_id:             rm.id,
      });

      edges.push({
        source: rmNodeId,
        target: clientNodeId,
        type:   'rm_to_client',
      });
    }

    nodes.push({
      id:           rmNodeId,
      type:         'rm',
      role:         'rm',
      stage:        1,
      parent_id:    cioNodeId,
      label:        rm.display_name,
      initials:     getInitials(rm.display_name),
      title:        'Relationship Manager',
      aum_cr:       rm.total_aum_cr || 0,
      team:         rm.team || 'Desk',
      alert_count:  rmAlertCount,
      client_count: rm.clients.length,
      raw_id:       rm.id,
    });
  }

  // Set aggregated CIO center node properties
  nodes[0].aum_cr = firmAum;
  nodes[0].alert_count = totalAlerts;

  return {
    meta: {
      type:          'cio_heartbeat',
      role:          'cio',
      stageCount:    4,
      center_id:     cioNodeId,
      center_label:  cioName,
      org_id:        org.id,
      org_name:      org.name,
      total_aum_cr:  firmAum,
      total_rms:     rms.length,
      total_clients: firmClients,
      total_alerts:  totalAlerts,
      generated_at:  new Date().toISOString(),
    },
    nodes,
    edges,
    alerts,
  };
}

/**
 * 5-Level Super Admin Heartbeat Graph:
 * Stage 0: Super Admin Node (Center, whoever logged in)
 * Stage 1: CIO Nodes
 * Stage 2: RM Nodes
 * Stage 3: Client Nodes
 * Stage 4: Holding Nodes
 */
async function getAdminHeartbeat(orgId, adminMember, adminUser, filters = {}) {
  const org = await prisma.wealthOrganisation.findUnique({
    where: { id: orgId },
    select: { id: true, name: true, slug: true },
  });

  if (!org) {
    const err = new Error('Organisation not found');
    err.status = 404;
    throw err;
  }

  // Find CIO members in the organisation
  const cioMembers = await prisma.wealthOrgMember.findMany({
    where: { org_id: orgId, role: 'cio', is_active: true },
    include: {
      user: {
        select: { id: true, display_name: true, email: true },
      },
    },
  });

  // Find RMs and their clients & holdings
  const rms = await prisma.wealthRmProfile.findMany({
    where:   { org_id: orgId },
    orderBy: { total_aum_cr: 'desc' },
    include: {
      clients: {
        orderBy: { aum_cr: 'desc' },
        include: {
          portfolio: {
            include: {
              holdings: {
                where: filters.asset_class ? { asset_class: filters.asset_class } : undefined,
                include: {
                  alerts: {
                    where: { is_resolved: false },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  const nodes = [];
  const edges = [];
  const alerts = [];
  let firmAum = 0;
  let firmClients = 0;
  let totalAlerts = 0;

  // Level 0: Super Admin Center
  const adminName = adminUser?.display_name || 'Super Admin';
  const adminNodeId = `admin-${adminMember?.id || 'root'}`;
  nodes.push({
    id:          adminNodeId,
    type:        'super_admin',
    role:        'super_admin',
    stage:       0,
    label:       adminName,
    initials:    getInitials(adminName),
    title:       'Super Admin / Firm Owner',
    aum_cr:      0, // computed below
    team:        org.name,
    raw_id:      adminMember?.id || org.id,
    alert_count: 0,
  });

  // Level 1: CIO Desk(s)
  const cioNodesMap = new Map();

  if (cioMembers.length === 0) {
    const defaultCioNodeId = 'cio-desk';
    nodes.push({
      id:          defaultCioNodeId,
      type:        'cio',
      role:        'cio',
      stage:       1,
      parent_id:   adminNodeId,
      label:       'Chief Investment Officer',
      initials:    'CI',
      title:       'Chief Investment Officer',
      aum_cr:      0,
      team:        'Investment Committee',
      alert_count: 0,
      raw_id:      'cio-desk',
    });
    edges.push({
      source: adminNodeId,
      target: defaultCioNodeId,
      type:   'admin_to_cio',
    });
    cioNodesMap.set('default', defaultCioNodeId);
  } else {
    cioMembers.forEach((cioMember, idx) => {
      const cioName = cioMember.user?.display_name || `CIO Desk ${idx + 1}`;
      const cioNodeId = `cio-${cioMember.id}`;
      const cioTeam = cioMember.user?.email?.includes('devika')
        ? 'Global & Alternative Strategies'
        : 'Core Strategies & Equities';

      nodes.push({
        id:          cioNodeId,
        type:        'cio',
        role:        'cio',
        stage:       1,
        parent_id:   adminNodeId,
        label:       cioName,
        initials:    getInitials(cioName),
        title:       'Chief Investment Officer',
        aum_cr:      0,
        team:        cioTeam,
        alert_count: 0,
        raw_id:      cioMember.id,
      });
      edges.push({
        source: adminNodeId,
        target: cioNodeId,
        type:   'admin_to_cio',
      });
      cioNodesMap.set(cioMember.id, cioNodeId);
    });
  }

  // Level 2: RMs
  const cioIdList = Array.from(cioNodesMap.values());
  const cioAumMap = new Map();
  const cioAlertMap = new Map();

  for (let rmIdx = 0; rmIdx < rms.length; rmIdx++) {
    const rm = rms[rmIdx];
    const rmNodeId = `rm-${rm.id}`;
    let rmAlertCount = 0;
    firmAum += rm.total_aum_cr || 0;
    firmClients += rm.clients.length;

    // Determine parent CIO node id: match by cio_member_id or distribute evenly
    let parentCioNodeId = rm.cio_member_id ? cioNodesMap.get(rm.cio_member_id) : null;
    if (!parentCioNodeId) {
      parentCioNodeId = cioIdList[rmIdx % cioIdList.length];
    }

    edges.push({
      source: parentCioNodeId,
      target: rmNodeId,
      type:   'cio_to_rm',
    });

    // Level 3: Clients
    for (const client of rm.clients) {
      const clientNodeId = `client-${client.id}`;
      let clientAlertCount = 0;

      const holdings = client.portfolio?.holdings || [];

      // Level 4: Holdings
      for (const h of holdings) {
        const holdingNodeId = `holding-${h.id}`;
        const holdingAlerts = h.alerts || [];
        const hasAlert = holdingAlerts.length > 0;

        if (hasAlert) {
          clientAlertCount += holdingAlerts.length;
          rmAlertCount += holdingAlerts.length;
          totalAlerts += holdingAlerts.length;
          for (const alert of holdingAlerts) {
            alerts.push({
              id:             alert.id,
              holding_id:     holdingNodeId,
              client_id:      clientNodeId,
              rm_id:          rmNodeId,
              raw_holding_id: h.id,
              raw_client_id:  client.id,
              alert_type:     alert.alert_type,
              severity:       alert.severity,
              message:        alert.message,
              threshold:      alert.threshold,
              actual_value:   alert.actual_value,
            });
          }
        }

        nodes.push({
          id:               holdingNodeId,
          type:             'holding',
          stage:            4,
          parent_id:        clientNodeId,
          label:            h.ticker || h.scheme_name || 'Asset',
          asset_class:      h.asset_class,
          current_value_cr: h.current_value_cr || 0,
          weight_pct:       h.weight_pct || 0,
          has_alert:        hasAlert,
          alert_count:      holdingAlerts.length,
          raw_id:           h.id,
          client_id:        client.id,
        });

        edges.push({
          source: clientNodeId,
          target: holdingNodeId,
          type:   'client_to_holding',
        });
      }

      nodes.push({
        id:                clientNodeId,
        type:              'client',
        stage:             3,
        parent_id:         rmNodeId,
        label:             client.name,
        initials:          getInitials(client.name),
        aum_cr:            client.aum_cr || 0,
        segment:           client.segment,
        lifecycle_status:  client.lifecycle_status,
        churn_probability: client.churn_probability || 0,
        holding_count:     holdings.length,
        alert_count:       clientAlertCount,
        raw_id:            client.id,
        rm_id:             rm.id,
      });

      edges.push({
        source: rmNodeId,
        target: clientNodeId,
        type:   'rm_to_client',
      });
    }

    nodes.push({
      id:           rmNodeId,
      type:         'rm',
      role:         'rm',
      stage:        2,
      parent_id:    parentCioNodeId,
      label:        rm.display_name,
      initials:     getInitials(rm.display_name),
      title:        'Relationship Manager',
      aum_cr:       rm.total_aum_cr || 0,
      team:         rm.team || 'Desk',
      alert_count:  rmAlertCount,
      client_count: rm.clients.length,
      raw_id:       rm.id,
    });

    // Accumulate AUM and alerts to parent CIO
    cioAumMap.set(parentCioNodeId, (cioAumMap.get(parentCioNodeId) || 0) + (rm.total_aum_cr || 0));
    cioAlertMap.set(parentCioNodeId, (cioAlertMap.get(parentCioNodeId) || 0) + rmAlertCount);
  }

  // Update aggregated center and cio node properties
  nodes[0].aum_cr = firmAum;
  nodes[0].alert_count = totalAlerts;

  nodes.forEach((n) => {
    if (n.type === 'cio') {
      n.aum_cr = Math.round((cioAumMap.get(n.id) || 0) * 100) / 100;
      n.alert_count = cioAlertMap.get(n.id) || 0;
    }
  });

  return {
    meta: {
      type:          'admin_heartbeat',
      role:          'super_admin',
      stageCount:    5,
      center_id:     adminNodeId,
      center_label:  adminName,
      org_id:        org.id,
      org_name:      org.name,
      total_aum_cr:  firmAum,
      total_rms:     rms.length,
      total_clients: firmClients,
      total_alerts:  totalAlerts,
      generated_at:  new Date().toISOString(),
    },
    nodes,
    edges,
    alerts,
  };
}

/**
 * Auto-detect user role and return their personalized Heartbeat Graph:
 * Whoever is logged in is placed at the center of the graph!
 */
async function getUserHeartbeat(orgId, member, user, filters = {}) {
  if (member.role === 'rm') {
    let rmProfileId = member.rm_profile?.id;
    if (!rmProfileId) {
      const profile = await prisma.wealthRmProfile.findFirst({
        where: { org_id: orgId, member_id: member.id },
      });
      rmProfileId = profile?.id;
    }
    if (!rmProfileId) {
      const err = new Error('No RM profile linked to this account');
      err.status = 404;
      throw err;
    }
    return getRmHeartbeat(orgId, rmProfileId);
  } else if (member.role === 'cio') {
    return getCioHeartbeat(orgId, member, user, filters);
  } else {
    // super_admin
    return getAdminHeartbeat(orgId, member, user, filters);
  }
}

module.exports = {
  getRmHeartbeat,
  getCioHeartbeat,
  getAdminHeartbeat,
  getUserHeartbeat,
};

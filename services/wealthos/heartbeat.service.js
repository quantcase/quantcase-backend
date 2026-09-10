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
 * RM Node (Center) -> Client Nodes -> Holding Nodes (+ Alert rings)
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

  // Level 0: RM Center Node
  const rmNodeId = `rm-${rm.id}`;
  nodes.push({
    id:       rmNodeId,
    type:     'rm',
    label:    rm.display_name,
    initials: getInitials(rm.display_name),
    aum_cr:   rm.total_aum_cr || 0,
    team:     rm.team || 'Private Wealth',
    raw_id:   rm.id,
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
            id:           alert.id,
            holding_id:   holdingNodeId,
            client_id:    clientNodeId,
            raw_holding_id: h.id,
            raw_client_id:  client.id,
            alert_type:   alert.alert_type,
            severity:     alert.severity,
            message:      alert.message,
            threshold:    alert.threshold,
            actual_value: alert.actual_value,
          });
        }
      }

      nodes.push({
        id:               holdingNodeId,
        type:             'holding',
        label:            h.ticker || h.scheme_name || 'Asset',
        asset_class:      h.asset_class,
        current_value_cr: h.current_value_cr || 0,
        weight_pct:       h.weight_pct || 0,
        has_alert:        hasAlert,
        alert_count:      holdingAlerts.length,
        raw_id:           h.id,
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
      label:             client.name,
      initials:          getInitials(client.name),
      aum_cr:            client.aum_cr || 0,
      segment:           client.segment,
      lifecycle_status:  client.lifecycle_status,
      churn_probability: client.churn_probability || 0,
      alert_count:       clientAlertCount,
      raw_id:            client.id,
    });
  }

  // Update RM center node alert count
  nodes[0].alert_count = totalAlerts;

  return {
    meta: {
      type:          'rm_heartbeat',
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
 * CIO Node (Center) -> RM Nodes -> Client Nodes -> Holding Nodes (+ Alert rings)
 */
async function getCioHeartbeat(orgId, filters = {}) {
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

  // Level 0: CIO / Firm Macro Center
  const cioNodeId = `cio-${org.id}`;
  nodes.push({
    id:       cioNodeId,
    type:     'cio',
    label:    `${org.name} Macro`,
    initials: getInitials(org.name),
    aum_cr:   0, // computed below
    raw_id:   org.id,
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
              id:           alert.id,
              holding_id:   holdingNodeId,
              client_id:    clientNodeId,
              rm_id:        rmNodeId,
              raw_holding_id: h.id,
              raw_client_id:  client.id,
              alert_type:   alert.alert_type,
              severity:     alert.severity,
              message:      alert.message,
              threshold:    alert.threshold,
              actual_value: alert.actual_value,
            });
          }
        }

        nodes.push({
          id:               holdingNodeId,
          type:             'holding',
          label:            h.ticker || h.scheme_name || 'Asset',
          asset_class:      h.asset_class,
          current_value_cr: h.current_value_cr || 0,
          weight_pct:       h.weight_pct || 0,
          has_alert:        hasAlert,
          alert_count:      holdingAlerts.length,
          raw_id:           h.id,
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
        label:             client.name,
        initials:          getInitials(client.name),
        aum_cr:            client.aum_cr || 0,
        segment:           client.segment,
        lifecycle_status:  client.lifecycle_status,
        churn_probability: client.churn_probability || 0,
        alert_count:       clientAlertCount,
        raw_id:            client.id,
      });

      edges.push({
        source: rmNodeId,
        target: clientNodeId,
        type:   'rm_to_client',
      });
    }

    nodes.push({
      id:          rmNodeId,
      type:        'rm',
      label:       rm.display_name,
      initials:    getInitials(rm.display_name),
      aum_cr:      rm.total_aum_cr || 0,
      team:        rm.team || 'Desk',
      alert_count: rmAlertCount,
      raw_id:      rm.id,
    });
  }

  // Set aggregated CIO center node properties
  nodes[0].aum_cr = firmAum;
  nodes[0].alert_count = totalAlerts;

  return {
    meta: {
      type:          'cio_heartbeat',
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

module.exports = { getRmHeartbeat, getCioHeartbeat };

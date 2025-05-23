/**
 * Plataforma de Mensajería Multicanal - Google App Script
 * Integración avanzada con Odoo 17 y Wazzup para WhatsApp
 * Sistema de transferencia de conversaciones
 */

// Configuración global
const CONFIG = {
  ODOO_URL: PropertiesService.getScriptProperties().getProperty('ODOO_URL') || '',
  ODOO_DB: PropertiesService.getScriptProperties().getProperty('ODOO_DB') || '',
  ODOO_USERNAME: PropertiesService.getScriptProperties().getProperty('ODOO_USERNAME') || '',
  ODOO_PASSWORD: PropertiesService.getScriptProperties().getProperty('ODOO_PASSWORD') || '',
  WAZZUP_API_KEY: PropertiesService.getScriptProperties().getProperty('WAZZUP_API_KEY') || '',
  WAZZUP_CHANNEL_ID: PropertiesService.getScriptProperties().getProperty('WAZZUP_CHANNEL_ID') || '',
  SPREADSHEET_ID: PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') || '',
  WEBHOOK_URL: PropertiesService.getScriptProperties().getProperty('WEBHOOK_URL') || ''
};

/**
 * Función principal para servir la aplicación web
 */
function doGet(e) {
  const page = e.parameter.page || 'inbox';
  
  try {
    const template = HtmlService.createTemplateFromFile('Index');
    template.page = page;
    template.config = CONFIG;
    
    return template.evaluate()
      .setTitle('MultiChat - Plataforma de Comunicación')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  } catch (error) {
    Logger.log('Error en doGet: ' + error.toString());
    return HtmlService.createHtmlOutput('<h1>Error al cargar la aplicación</h1>');
  }
}

/**
 * Incluir archivos HTML en las plantillas
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// ==================== INTEGRACIÓN AVANZADA CON ODOO ====================

/**
 * Autenticar con Odoo y obtener session_id
 */
function authenticateOdoo() {
  try {
    if (!CONFIG.ODOO_URL || !CONFIG.ODOO_DB || !CONFIG.ODOO_USERNAME || !CONFIG.ODOO_PASSWORD) {
      throw new Error('Configuración de Odoo incompleta');
    }

    const authPayload = {
      jsonrpc: "2.0",
      method: "call",
      params: {
        service: "common",
        method: "authenticate",
        args: [CONFIG.ODOO_DB, CONFIG.ODOO_USERNAME, CONFIG.ODOO_PASSWORD, {}]
      },
      id: Math.floor(Math.random() * 1000000)
    };

    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      payload: JSON.stringify(authPayload)
    };

    const response = UrlFetchApp.fetch(CONFIG.ODOO_URL + '/jsonrpc', options);
    const result = JSON.parse(response.getContentText());

    if (result.error) {
      throw new Error('Error de autenticación Odoo: ' + result.error.message);
    }

    const uid = result.result;
    if (!uid) {
      throw new Error('Credenciales de Odoo inválidas');
    }

    // Guardar UID para futuras llamadas
    PropertiesService.getScriptProperties().setProperty('ODOO_UID', uid.toString());
    
    Logger.log('Autenticación Odoo exitosa. UID: ' + uid);
    return uid;
  } catch (error) {
    Logger.log('Error en autenticación Odoo: ' + error.toString());
    throw error;
  }
}

/**
 * Realizar llamada a Odoo RPC
 */
function callOdooRPC(model, method, args = [], kwargs = {}) {
  try {
    const uid = PropertiesService.getScriptProperties().getProperty('ODOO_UID') || authenticateOdoo();

    const payload = {
      jsonrpc: "2.0",
      method: "call",
      params: {
        service: "object",
        method: "execute_kw",
        args: [
          CONFIG.ODOO_DB,
          parseInt(uid),
          CONFIG.ODOO_PASSWORD,
          model,
          method,
          args,
          kwargs
        ]
      },
      id: Math.floor(Math.random() * 1000000)
    };

    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      payload: JSON.stringify(payload)
    };

    const response = UrlFetchApp.fetch(CONFIG.ODOO_URL + '/jsonrpc', options);
    const result = JSON.parse(response.getContentText());

    if (result.error) {
      // Si es error de sesión, reautenticar
      if (result.error.message && result.error.message.includes('session')) {
        Logger.log('Sesión expirada, reautenticando...');
        authenticateOdoo();
        return callOdooRPC(model, method, args, kwargs);
      }
      throw new Error('Error RPC Odoo: ' + result.error.message);
    }

    return result.result;
  } catch (error) {
    Logger.log('Error en llamada RPC: ' + error.toString());
    throw error;
  }
}

/**
 * Sincronizar contacto con Odoo
 */
function syncContactWithOdoo(contactData) {
  try {
    // Buscar si el contacto ya existe
    const existingPartners = callOdooRPC('res.partner', 'search_read', [
      ['|', ['mobile', '=', contactData.phone], ['email', '=', contactData.email]]
    ], {
      fields: ['id', 'name', 'mobile', 'email']
    });

    let partnerId;

    if (existingPartners.length > 0) {
      // Actualizar contacto existente
      partnerId = existingPartners[0].id;
      const updateData = {
        name: contactData.name || existingPartners[0].name,
        mobile: contactData.phone || existingPartners[0].mobile,
        email: contactData.email || existingPartners[0].email,
        comment: contactData.lastMessage,
        is_company: false,
        customer_rank: 1
      };

      callOdooRPC('res.partner', 'write', [[partnerId], updateData]);
      Logger.log('Contacto actualizado en Odoo. ID: ' + partnerId);
    } else {
      // Crear nuevo contacto
      const createData = {
        name: contactData.name,
        mobile: contactData.phone,
        email: contactData.email,
        comment: contactData.lastMessage,
        is_company: false,
        customer_rank: 1,
        category_id: [[6, 0, []]] // Tags vacías por ahora
      };

      partnerId = callOdooRPC('res.partner', 'create', [createData]);
      Logger.log('Nuevo contacto creado en Odoo. ID: ' + partnerId);
    }

    // Guardar el partner_id en la conversación
    if (contactData.conversationId) {
      updateConversationOdooId(contactData.conversationId, partnerId);
    }

    return { success: true, partnerId: partnerId };
  } catch (error) {
    Logger.log('Error al sincronizar contacto con Odoo: ' + error.toString());
    return { success: false, error: error.toString() };
  }
}

/**
 * Crear oportunidad en Odoo
 */
function createOdooLead(conversationId, leadData = {}) {
  try {
    const conversation = getConversationById(conversationId);
    if (!conversation) {
      throw new Error('Conversación no encontrada');
    }

    // Sincronizar contacto primero si no existe
    let partnerId = conversation.odooPartnerId;
    if (!partnerId) {
      const syncResult = syncContactWithOdoo({
        conversationId: conversationId,
        name: conversation.name,
        phone: conversation.phone,
        email: conversation.email,
        lastMessage: conversation.lastMessage
      });
      
      if (!syncResult.success) {
        throw new Error('Error al sincronizar contacto: ' + syncResult.error);
      }
      partnerId = syncResult.partnerId;
    }

    // Crear la oportunidad
    const leadCreateData = {
      name: leadData.name || `Oportunidad desde ${conversation.channel} - ${conversation.name}`,
      partner_id: partnerId,
      description: leadData.description || conversation.lastMessage,
      medium_id: getOdooMediumId(conversation.channel),
      source_id: getOdooSourceId(conversation.channel),
      stage_id: 1, // Primera etapa del pipeline
      user_id: leadData.userId || false, // Asignar a usuario específico
      team_id: leadData.teamId || false, // Asignar a equipo específico
      priority: leadData.priority || '1', // Normal
      tag_ids: [[6, 0, leadData.tagIds || []]]
    };

    const leadId = callOdooRPC('crm.lead', 'create', [leadCreateData]);
    
    // Registrar la actividad en la conversación
    addConversationActivity(conversationId, 'odoo_lead_created', {
      leadId: leadId,
      leadName: leadCreateData.name
    });

    Logger.log('Oportunidad creada en Odoo. ID: ' + leadId);
    return { success: true, leadId: leadId };
  } catch (error) {
    Logger.log('Error al crear oportunidad en Odoo: ' + error.toString());
    return { success: false, error: error.toString() };
  }
}

/**
 * Crear tarea en Odoo
 */
function createOdooTask(conversationId, taskData = {}) {
  try {
    const conversation = getConversationById(conversationId);
    if (!conversation) {
      throw new Error('Conversación no encontrada');
    }

    // Buscar proyecto por defecto o crear uno
    let projectId = taskData.projectId;
    if (!projectId) {
      const projects = callOdooRPC('project.project', 'search', [
        ['name', '=', 'Tareas de MultiChat']
      ]);
      
      if (projects.length === 0) {
        projectId = callOdooRPC('project.project', 'create', [{
          name: 'Tareas de MultiChat',
          description: 'Tareas generadas desde la plataforma de mensajería'
        }]);
      } else {
        projectId = projects[0];
      }
    }

    const taskCreateData = {
      name: taskData.name || `Tarea desde ${conversation.channel} - ${conversation.name}`,
      description: taskData.description || conversation.lastMessage,
      project_id: projectId,
      user_ids: taskData.userIds ? [[6, 0, taskData.userIds]] : false,
      priority: taskData.priority || '0', // Normal
      date_deadline: taskData.deadline || false,
      tag_ids: [[6, 0, taskData.tagIds || []]]
    };

    // Si hay partner_id, agregarlo
    if (conversation.odooPartnerId) {
      taskCreateData.partner_id = conversation.odooPartnerId;
    }

    const taskId = callOdooRPC('project.task', 'create', [taskCreateData]);
    
    // Registrar la actividad en la conversación
    addConversationActivity(conversationId, 'odoo_task_created', {
      taskId: taskId,
      taskName: taskCreateData.name
    });

    Logger.log('Tarea creada en Odoo. ID: ' + taskId);
    return { success: true, taskId: taskId };
  } catch (error) {
    Logger.log('Error al crear tarea en Odoo: ' + error.toString());
    return { success: false, error: error.toString() };
  }
}

/**
 * Obtener ID de medio en Odoo según el canal
 */
function getOdooMediumId(channel) {
  const mediumMap = {
    'whatsapp': 'WhatsApp',
    'sms': 'SMS',
    'email': 'Email'
  };
  
  try {
    const mediums = callOdooRPC('utm.medium', 'search_read', [
      ['name', '=', mediumMap[channel] || 'Otro']
    ], { fields: ['id'] });
    
    return mediums.length > 0 ? mediums[0].id : false;
  } catch (error) {
    Logger.log('Error al obtener medium ID: ' + error.toString());
    return false;
  }
}

/**
 * Obtener ID de fuente en Odoo
 */
function getOdooSourceId(channel) {
  try {
    const sources = callOdooRPC('utm.source', 'search_read', [
      ['name', '=', 'MultiChat']
    ], { fields: ['id'] });
    
    if (sources.length === 0) {
      // Crear fuente si no existe
      const sourceId = callOdooRPC('utm.source', 'create', [{
        name: 'MultiChat',
        description: 'Plataforma de mensajería multicanal'
      }]);
      return sourceId;
    }
    
    return sources[0].id;
  } catch (error) {
    Logger.log('Error al obtener source ID: ' + error.toString());
    return false;
  }
}

// ==================== INTEGRACIÓN ROBUSTA CON WAZZUP ====================

/**
 * Configurar webhook de Wazzup
 */
function setupWazzupWebhook() {
  try {
    if (!CONFIG.WAZZUP_API_KEY || !CONFIG.WEBHOOK_URL) {
      throw new Error('Configuración de Wazzup incompleta');
    }

    const payload = {
      url: CONFIG.WEBHOOK_URL,
      events: ['message', 'status']
    };

    const options = {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + CONFIG.WAZZUP_API_KEY,
        'Content-Type': 'application/json'
      },
      payload: JSON.stringify(payload)
    };

    const response = UrlFetchApp.fetch('https://api.wazzup24.com/v3/webhook', options);
    const result = JSON.parse(response.getContentText());

    if (response.getResponseCode() === 200) {
      Logger.log('Webhook de Wazzup configurado correctamente');
      return { success: true, webhookId: result.id };
    } else {
      throw new Error('Error al configurar webhook: ' + result.message);
    }
  } catch (error) {
    Logger.log('Error al configurar webhook de Wazzup: ' + error.toString());
    return { success: false, error: error.toString() };
  }
}

/**
 * Enviar mensaje por WhatsApp usando Wazzup API
 */
function sendWhatsAppMessage(conversationId, content, messageType = 'text', mediaUrl = null) {
  try {
    if (!CONFIG.WAZZUP_API_KEY || !CONFIG.WAZZUP_CHANNEL_ID) {
      throw new Error('Configuración de Wazzup incompleta');
    }
    
    const conversation = getConversationById(conversationId);
    if (!conversation || !conversation.phone) {
      throw new Error('No se encontró número de teléfono para la conversación');
    }

    let payload = {
      channelId: CONFIG.WAZZUP_CHANNEL_ID,
      chatId: conversation.phone.replace(/\D/g, ''), // Solo números
      chatType: 'whatsapp'
    };

    // Configurar según el tipo de mensaje
    switch (messageType) {
      case 'text':
        payload.text = content;
        break;
      case 'image':
        payload.image = {
          url: mediaUrl,
          caption: content
        };
        break;
      case 'document':
        payload.document = {
          url: mediaUrl,
          filename: content
        };
        break;
      case 'template':
        payload.hsm = content; // Para plantillas de WhatsApp Business
        break;
    }
    
    const options = {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + CONFIG.WAZZUP_API_KEY,
        'Content-Type': 'application/json'
      },
      payload: JSON.stringify(payload)
    };
    
    const response = UrlFetchApp.fetch('https://api.wazzup24.com/v3/message', options);
    const result = JSON.parse(response.getContentText());
    
    if (response.getResponseCode() === 200) {
      Logger.log('Mensaje WhatsApp enviado correctamente. ID: ' + result.id);
      return { success: true, messageId: result.id, wazzupId: result.id };
    } else {
      throw new Error('Error al enviar mensaje: ' + result.message);
    }
  } catch (error) {
    Logger.log('Error al enviar WhatsApp: ' + error.toString());
    return { success: false, error: error.toString() };
  }
}

/**
 * Obtener estado de mensaje de Wazzup
 */
function getWazzupMessageStatus(wazzupMessageId) {
  try {
    const options = {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + CONFIG.WAZZUP_API_KEY
      }
    };

    const response = UrlFetchApp.fetch(`https://api.wazzup24.com/v3/message/${wazzupMessageId}`, options);
    const result = JSON.parse(response.getContentText());

    if (response.getResponseCode() === 200) {
      return { success: true, status: result.status };
    } else {
      throw new Error('Error al obtener estado: ' + result.message);
    }
  } catch (error) {
    Logger.log('Error al obtener estado de mensaje: ' + error.toString());
    return { success: false, error: error.toString() };
  }
}

// ==================== SISTEMA DE TRANSFERENCIA DE CONVERSACIONES ====================

/**
 * Obtener agentes disponibles
 */
function getAvailableAgents() {
  try {
    const spreadsheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const sheet = spreadsheet.getSheetByName('Agentes') || spreadsheet.insertSheet('Agentes');
    
    // Crear agentes por defecto si no existen
    if (sheet.getLastRow() <= 1) {
      sheet.getRange(1, 1, 1, 7).setValues([['ID', 'Nombre', 'Email', 'Equipo', 'Estado', 'Conversaciones', 'Última actividad']]);
      
      const defaultAgents = [
        ['agent_1', 'Juan Pérez', 'juan@empresa.com', 'Ventas', 'disponible', 0, new Date()],
        ['agent_2', 'María González', 'maria@empresa.com', 'Soporte', 'disponible', 0, new Date()],
        ['agent_3', 'Carlos Rodríguez', 'carlos@empresa.com', 'Ventas', 'ocupado', 3, new Date()]
      ];
      
      sheet.getRange(2, 1, defaultAgents.length, 7).setValues(defaultAgents);
    }
    
    const data = sheet.getDataRange().getValues();
    const agents = [];
    
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      agents.push({
        id: row[0],
        name: row[1],
        email: row[2],
        team: row[3],
        status: row[4],
        conversationCount: row[5],
        lastActivity: row[6]
      });
    }
    
    return agents;
  } catch (error) {
    Logger.log('Error al obtener agentes: ' + error.toString());
    return [];
  }
}

/**
 * Asignar conversación a agente
 */
function assignConversation(conversationId, agentId, reason = 'manual') {
  try {
    const spreadsheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const conversationsSheet = spreadsheet.getSheetByName('Conversaciones');
    const transfersSheet = spreadsheet.getSheetByName('Transferencias') || spreadsheet.insertSheet('Transferencias');
    
    // Crear cabeceras de transferencias si no existen
    if (transfersSheet.getLastRow() === 0) {
      transfersSheet.getRange(1, 1, 1, 7).setValues([
        ['ID', 'Conversación ID', 'Agente Anterior', 'Agente Nuevo', 'Motivo', 'Fecha', 'Notas']
      ]);
    }
    
    // Obtener conversación actual
    const conversation = getConversationById(conversationId);
    if (!conversation) {
      throw new Error('Conversación no encontrada');
    }
    
    const previousAgent = conversation.assignedAgent || 'sin_asignar';
    
    // Actualizar asignación en la conversación
    const conversationsData = conversationsSheet.getDataRange().getValues();
    for (let i = 1; i < conversationsData.length; i++) {
      if (conversationsData[i][0] === conversationId) {
        conversationsSheet.getRange(i + 1, 12).setValue(agentId); // Columna de agente asignado
        conversationsSheet.getRange(i + 1, 13).setValue(new Date()); // Fecha de asignación
        break;
      }
    }
    
    // Registrar transferencia
    const transferId = Utilities.getUuid();
    transfersSheet.appendRow([
      transferId,
      conversationId,
      previousAgent,
      agentId,
      reason,
      new Date(),
      ''
    ]);
    
    // Actualizar contador de conversaciones del agente
    updateAgentConversationCount(agentId, 1);
    if (previousAgent !== 'sin_asignar') {
      updateAgentConversationCount(previousAgent, -1);
    }
    
    // Registrar actividad en la conversación
    addConversationActivity(conversationId, 'conversation_assigned', {
      previousAgent: previousAgent,
      newAgent: agentId,
      reason: reason
    });
    
    // Notificar al agente (opcional)
    notifyAgent(agentId, conversationId, 'assignment');
    
    Logger.log(`Conversación ${conversationId} asignada a agente ${agentId}`);
    return { success: true, transferId: transferId };
  } catch (error) {
    Logger.log('Error al asignar conversación: ' + error.toString());
    return { success: false, error: error.toString() };
  }
}

/**
 * Transferir conversación entre agentes
 */
function transferConversation(conversationId, fromAgentId, toAgentId, reason, notes = '') {
  try {
    const spreadsheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const transfersSheet = spreadsheet.getSheetByName('Transferencias');
    
    // Si no se proporciona fromAgentId, obtenerlo de la conversación
    if (!fromAgentId) {
      const conversation = getConversationById(conversationId);
      fromAgentId = conversation.assignedAgent || 'sin_asignar';
    }
    
    // Registrar transferencia
    const transferId = Utilities.getUuid();
    transfersSheet.appendRow([
      transferId,
      conversationId,
      fromAgentId,
      toAgentId,
      reason,
      new Date(),
      notes
    ]);
    
    // Asignar al nuevo agente
    const assignResult = assignConversation(conversationId, toAgentId, reason);
    
    if (assignResult.success) {
      // Enviar mensaje automático de transferencia
      const transferMessage = `Esta conversación ha sido transferida a otro agente. Motivo: ${reason}`;
      addSystemMessage(conversationId, transferMessage);
      
      // Notificar a ambos agentes
      notifyAgent(fromAgentId, conversationId, 'transfer_out');
      notifyAgent(toAgentId, conversationId, 'transfer_in');
      
      Logger.log(`Conversación transferida de ${fromAgentId} a ${toAgentId}`);
      return { success: true, transferId: transferId };
    } else {
      throw new Error('Error en la asignación: ' + assignResult.error);
    }
  } catch (error) {
    Logger.log('Error al transferir conversación: ' + error.toString());
    return { success: false, error: error.toString() };
  }
}

/**
 * Obtener historial de transferencias
 */
function getTransferHistory(conversationId) {
  try {
    const spreadsheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const sheet = spreadsheet.getSheetByName('Transferencias');
    
    if (!sheet || sheet.getLastRow() <= 1) {
      return [];
    }
    
    const data = sheet.getDataRange().getValues();
    const transfers = [];
    
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (row[1] === conversationId) {
        transfers.push({
          id: row[0],
          conversationId: row[1],
          fromAgent: row[2],
          toAgent: row[3],
          reason: row[4],
          date: row[5],
          notes: row[6]
        });
      }
    }
    
    return transfers.sort((a, b) => new Date(b.date) - new Date(a.date));
  } catch (error) {
    Logger.log('Error al obtener historial de transferencias: ' + error.toString());
    return [];
  }
}

/**
 * Asignación automática basada en carga de trabajo
 */
function autoAssignConversation(conversationId, teamFilter = null) {
  try {
    const agents = getAvailableAgents().filter(agent => {
      return agent.status === 'disponible' && 
             (teamFilter ? agent.team === teamFilter : true);
    });
    
    if (agents.length === 0) {
      Logger.log('No hay agentes disponibles para asignación automática');
      return { success: false, error: 'No hay agentes disponibles' };
    }
    
    // Ordenar por menor carga de trabajo
    agents.sort((a, b) => a.conversationCount - b.conversationCount);
    
    const selectedAgent = agents[0];
    const assignResult = assignConversation(conversationId, selectedAgent.id, 'auto_assignment');
    
    if (assignResult.success) {
      Logger.log(`Conversación auto-asignada a ${selectedAgent.name}`);
    }
    
    return assignResult;
  } catch (error) {
    Logger.log('Error en asignación automática: ' + error.toString());
    return { success: false, error: error.toString() };
  }
}

// ==================== FUNCIONES AUXILIARES ====================

/**
 * Actualizar contador de conversaciones del agente
 */
function updateAgentConversationCount(agentId, increment) {
  try {
    const spreadsheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const sheet = spreadsheet.getSheetByName('Agentes');
    const data = sheet.getDataRange().getValues();
    
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === agentId) {
        const currentCount = data[i][5] || 0;
        const newCount = Math.max(0, currentCount + increment);
        sheet.getRange(i + 1, 6).setValue(newCount);
        sheet.getRange(i + 1, 7).setValue(new Date()); // Última actividad
        break;
      }
    }
  } catch (error) {
    Logger.log('Error al actualizar contador de agente: ' + error.toString());
  }
}

/**
 * Notificar a agente
 */
function notifyAgent(agentId, conversationId, notificationType) {
  try {
    const agent = getAvailableAgents().find(a => a.id === agentId);
    if (!agent) return;
    
    let subject, body;
    
    switch (notificationType) {
      case 'assignment':
        subject = 'Nueva conversación asignada';
        body = `Se te ha asignado una nueva conversación. ID: ${conversationId}`;
        break;
      case 'transfer_in':
        subject = 'Conversación transferida a ti';
        body = `Se te ha transferido una conversación. ID: ${conversationId}`;
        break;
      case 'transfer_out':
        subject = 'Conversación transferida';
        body = `Tu conversación ${conversationId} ha sido transferida a otro agente.`;
        break;
    }
    
    // Enviar email de notificación
    MailApp.sendEmail({
      to: agent.email,
      subject: subject,
      body: body
    });
    
    Logger.log(`Notificación enviada a ${agent.email}: ${subject}`);
  } catch (error) {
    Logger.log('Error al notificar agente: ' + error.toString());
  }
}

/**
 * Agregar mensaje del sistema
 */
function addSystemMessage(conversationId, content) {
  try {
    const messageId = Utilities.getUuid();
    const spreadsheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const messagesSheet = spreadsheet.getSheetByName('Mensajes');
    
    messagesSheet.appendRow([
      messageId,
      conversationId,
      content,
      'system',
      new Date().toISOString(),
      'delivered',
      'system'
    ]);
    
    return messageId;
  } catch (error) {
    Logger.log('Error al agregar mensaje del sistema: ' + error.toString());
    return null;
  }
}

/**
 * Agregar actividad a conversación
 */
function addConversationActivity(conversationId, activityType, data = {}) {
  try {
    const spreadsheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const sheet = spreadsheet.getSheetByName('Actividades') || spreadsheet.insertSheet('Actividades');
    
    if (sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, 5).setValues([
        ['ID', 'Conversación ID', 'Tipo', 'Datos', 'Fecha']
      ]);
    }
    
    const activityId = Utilities.getUuid();
    sheet.appendRow([
      activityId,
      conversationId,
      activityType,
      JSON.stringify(data),
      new Date()
    ]);
    
    return activityId;
  } catch (error) {
    Logger.log('Error al agregar actividad: ' + error.toString());
    return null;
  }
}

/**
 * Actualizar ID de Odoo en conversación
 */
function updateConversationOdooId(conversationId, partnerId) {
  try {
    const spreadsheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const sheet = spreadsheet.getSheetByName('Conversaciones');
    const data = sheet.getDataRange().getValues();
    
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === conversationId) {
        sheet.getRange(i + 1, 14).setValue(partnerId); // Columna para Odoo Partner ID
        break;
      }
    }
  } catch (error) {
    Logger.log('Error al actualizar Odoo ID: ' + error.toString());
  }
}

// ==================== FUNCIONES EXISTENTES MEJORADAS ====================

/**
 * Obtener conversaciones con información de asignación
 */
function getConversations() {
  try {
    const spreadsheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const sheet = spreadsheet.getSheetByName('Conversaciones') || spreadsheet.insertSheet('Conversaciones');
    
    // Crear cabeceras si no existen
    if (sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, 15).setValues([[
        'ID', 'Nombre', 'Teléfono', 'Email', 'Canal', 'Último mensaje', 'Hora último mensaje', 
        'No leídos', 'Estado', 'Etiquetas', 'Creado', 'Agente asignado', 'Asignado en', 'Odoo Partner ID', 'Datos adicionales'
      ]]);
    }
    
    const data = sheet.getDataRange().getValues();
    if (data.length <= 1) return [];
    
    const conversations = [];
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      conversations.push({
        id: row[0] || '',
        name: row[1] || '',
        phone: row[2] || '',
        email: row[3] || '',
        channel: row[4] || '',
        lastMessage: row[5] || '',
        lastMessageTime: row[6] || '',
        unreadCount: row[7] || 0,
        status: row[8] || 'active',
        tags: row[9] ? row[9].split(',') : [],
        createdAt: row[10] || new Date(),
        assignedAgent: row[11] || null,
        assignedAt: row[12] || null,
        odooPartnerId: row[13] || null,
        additionalData: row[14] ? JSON.parse(row[14]) : {}
      });
    }
    
    return conversations.sort((a, b) => new Date(b.lastMessageTime) - new Date(a.lastMessageTime));
  } catch (error) {
    Logger.log('Error al obtener conversaciones: ' + error.toString());
    return [];
  }
}

/**
 * Obtener conversación por ID
 */
function getConversationById(id) {
  const conversations = getConversations();
  return conversations.find(conv => conv.id === id);
}

/**
 * Obtener mensajes de una conversación
 */
function getMessages(conversationId) {
  try {
    const spreadsheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const sheet = spreadsheet.getSheetByName('Mensajes') || spreadsheet.insertSheet('Mensajes');
    
    // Crear cabeceras si no existen
    if (sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, 8).setValues([[
        'ID', 'Conversación ID', 'Contenido', 'Remitente', 'Timestamp', 'Estado', 'Tipo', 'Wazzup ID'
      ]]);
    }
    
    const data = sheet.getDataRange().getValues();
    if (data.length <= 1) return [];
    
    const messages = [];
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (row[1] === conversationId) {
        messages.push({
          id: row[0] || '',
          conversationId: row[1] || '',
          content: row[2] || '',
          sender: row[3] || '',
          timestamp: row[4] || '',
          status: row[5] || 'sent',
          type: row[6] || 'text',
          wazzupId: row[7] || null
        });
      }
    }
    
    return messages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  } catch (error) {
    Logger.log('Error al obtener mensajes: ' + error.toString());
    return [];
  }
}

/**
 * Obtener datos completos de una conversación (conversación + mensajes)
 */
function getConversationData(conversationId) {
  try {
    const conversation = getConversationById(conversationId);
    if (!conversation) {
      throw new Error('Conversación no encontrada');
    }
    
    const messages = getMessages(conversationId);
    
    // Marcar mensajes como leídos
    markConversationAsRead(conversationId);
    
    return {
      conversation: conversation,
      messages: messages
    };
  } catch (error) {
    Logger.log('Error al obtener datos de conversación: ' + error.toString());
    return { conversation: null, messages: [] };
  }
}

/**
 * Marcar conversación como leída
 */
function markConversationAsRead(conversationId) {
  try {
    const spreadsheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const sheet = spreadsheet.getSheetByName('Conversaciones');
    const data = sheet.getDataRange().getValues();
    
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === conversationId) {
        sheet.getRange(i + 1, 8).setValue(0); // Columna de no leídos
        break;
      }
    }
  } catch (error) {
    Logger.log('Error al marcar conversación como leída: ' + error.toString());
  }
}

/**
 * Enviar mensaje
 */
function sendMessage(conversationId, content, channel = null) {
  try {
    const conversation = getConversationById(conversationId);
    if (!conversation) {
      throw new Error('Conversación no encontrada');
    }
    
    // Usar el canal de la conversación si no se especifica
    channel = channel || conversation.channel;
    
    const messageId = Utilities.getUuid();
    const timestamp = new Date().toISOString();
    
    // Guardar mensaje en Google Sheets
    const spreadsheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const messagesSheet = spreadsheet.getSheetByName('Mensajes');
    
    messagesSheet.appendRow([
      messageId,
      conversationId,
      content,
      channel === 'system' ? 'system' : 'user',
      timestamp,
      'sending',
      'text',
      null // Wazzup ID
    ]);
    
    // Enviar según el canal
    let success = false;
    let wazzupId = null;
    
    if (channel === 'whatsapp') {
      const result = sendWhatsAppMessage(conversationId, content);
      success = result.success;
      wazzupId = result.wazzupId;
    } else if (channel === 'sms') {
      success = sendSMSMessage(conversationId, content);
    } else if (channel === 'email') {
      success = sendEmailMessage(conversationId, content);
    } else if (channel === 'system') {
      success = true; // Los mensajes del sistema siempre son exitosos
    }
    
    // Actualizar estado del mensaje
    const status = success ? 'sent' : 'failed';
    updateMessageStatus(messageId, status, wazzupId);
    
    // Actualizar última actividad de la conversación
    updateConversationLastMessage(conversationId, content, timestamp);
    
    return { success: success, messageId: messageId };
  } catch (error) {
    Logger.log('Error al enviar mensaje: ' + error.toString());
    return { success: false, error: error.toString() };
  }
}

/**
 * Actualizar estado de mensaje
 */
function updateMessageStatus(messageId, status, wazzupId = null) {
  try {
    const spreadsheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const sheet = spreadsheet.getSheetByName('Mensajes');
    const data = sheet.getDataRange().getValues();
    
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === messageId) {
        sheet.getRange(i + 1, 6).setValue(status);
        if (wazzupId) {
          sheet.getRange(i + 1, 8).setValue(wazzupId);
        }
        break;
      }
    }
  } catch (error) {
    Logger.log('Error al actualizar estado de mensaje: ' + error.toString());
  }
}

/**
 * Actualizar último mensaje de conversación
 */
function updateConversationLastMessage(conversationId, message, timestamp) {
  try {
    const spreadsheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const sheet = spreadsheet.getSheetByName('Conversaciones');
    const data = sheet.getDataRange().getValues();
    
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === conversationId) {
        sheet.getRange(i + 1, 6).setValue(message.substring(0, 100));
        sheet.getRange(i + 1, 7).setValue(timestamp);
        break;
      }
    }
  } catch (error) {
    Logger.log('Error al actualizar último mensaje: ' + error.toString());
  }
}

/**
 * Encontrar o crear conversación
 */
function findOrCreateConversation(phone, channel, name) {
  const conversations = getConversations();
  let conversation = conversations.find(conv => conv.phone === phone);
  
  if (!conversation) {
    const conversationId = Utilities.getUuid();
    const spreadsheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const sheet = spreadsheet.getSheetByName('Conversaciones');
    
    sheet.appendRow([
      conversationId,
      name || phone,
      phone,
      '',
      channel,
      '',
      new Date().toISOString(),
      0,
      'active',
      '',
      new Date().toISOString(),
      null, // Agente asignado
      null, // Fecha de asignación
      null, // Odoo Partner ID
      '{}' // Datos adicionales
    ]);
    
    return conversationId;
  }
  
  return conversation.id;
}

/**
 * Webhook mejorado para recibir mensajes de Wazzup
 */
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    Logger.log('Webhook recibido: ' + JSON.stringify(data));
    
    if (data.type === 'message' && data.chatType === 'whatsapp') {
      const conversationId = findOrCreateConversation(data.chatId, 'whatsapp', data.senderName);
      
      // Guardar mensaje
      const messageId = Utilities.getUuid();
      const spreadsheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
      const messagesSheet = spreadsheet.getSheetByName('Mensajes');
      
      messagesSheet.appendRow([
        messageId,
        conversationId,
        data.text || data.caption || '[Archivo multimedia]',
        'contact',
        new Date().toISOString(),
        'received',
        data.messageType || 'text',
        data.messageId || null
      ]);
      
      // Procesar automatizaciones
      processAutomations(conversationId, data.text || '');
      
      // Actualizar conversación
      updateConversationLastMessage(conversationId, data.text || '[Archivo multimedia]', new Date().toISOString());
      
      // Incrementar contador de no leídos
      incrementUnreadCount(conversationId);
      
      // Auto-asignar si no está asignada
      const conversation = getConversationById(conversationId);
      if (!conversation.assignedAgent) {
        autoAssignConversation(conversationId);
      }
      
    } else if (data.type === 'status') {
      // Actualizar estado de mensaje
      updateMessageStatusFromWazzup(data.messageId, data.status);
    }
    
    return HtmlService.createHtmlOutput('OK');
  } catch (error) {
    Logger.log('Error en webhook: ' + error.toString());
    return HtmlService.createHtmlOutput('Error: ' + error.toString());
  }
}

/**
 * Incrementar contador de no leídos
 */
function incrementUnreadCount(conversationId) {
  try {
    const spreadsheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const sheet = spreadsheet.getSheetByName('Conversaciones');
    const data = sheet.getDataRange().getValues();
    
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === conversationId) {
        const currentCount = data[i][7] || 0;
        sheet.getRange(i + 1, 8).setValue(currentCount + 1);
        break;
      }
    }
  } catch (error) {
    Logger.log('Error al incrementar contador de no leídos: ' + error.toString());
  }
}

/**
 * Actualizar estado de mensaje desde Wazzup
 */
function updateMessageStatusFromWazzup(wazzupMessageId, status) {
  try {
    const spreadsheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const sheet = spreadsheet.getSheetByName('Mensajes');
    const data = sheet.getDataRange().getValues();
    
    for (let i = 1; i < data.length; i++) {
      if (data[i][7] === wazzupMessageId) { // Columna para Wazzup Message ID
        const newStatus = mapWazzupStatus(status);
        sheet.getRange(i + 1, 6).setValue(newStatus);
        break;
      }
    }
  } catch (error) {
    Logger.log('Error al actualizar estado desde Wazzup: ' + error.toString());
  }
}

/**
 * Mapear estados de Wazzup a estados internos
 */
function mapWazzupStatus(wazzupStatus) {
  const statusMap = {
    'sent': 'sent',
    'delivered': 'delivered',
    'read': 'read',
    'failed': 'failed'
  };
  
  return statusMap[wazzupStatus] || 'sent';
}

/**
 * Procesar automatizaciones para un mensaje
 */
function processAutomations(conversationId, message) {
  try {
    const automations = getAutomations().filter(auto => auto.active);
    
    for (const automation of automations) {
      let shouldTrigger = false;
      
      // Evaluar trigger
      if (automation.trigger === 'first_message') {
        const messages = getMessages(conversationId);
        shouldTrigger = messages.length === 1;
      } else if (automation.trigger.startsWith('keyword:')) {
        const keyword = automation.trigger.split(':')[1];
        shouldTrigger = message.toLowerCase().includes(keyword.toLowerCase());
      }
      
      if (shouldTrigger) {
        executeAutomationActions(conversationId, automation.actions);
      }
    }
  } catch (error) {
    Logger.log('Error al procesar automatizaciones: ' + error.toString());
  }
}

/**
 * Obtener automatizaciones
 */
function getAutomations() {
  try {
    const spreadsheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const sheet = spreadsheet.getSheetByName('Automatizaciones') || spreadsheet.insertSheet('Automatizaciones');
    
    if (sheet.getLastRow() <= 1) {
      sheet.getRange(1, 1, 1, 7).setValues([['ID', 'Nombre', 'Descripción', 'Trigger', 'Acciones', 'Activa', 'Creada']]);
    }
    
    const data = sheet.getDataRange().getValues();
    const automations = [];
    
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      automations.push({
        id: row[0],
        name: row[1],
        description: row[2],
        trigger: row[3],
        actions: row[4] ? JSON.parse(row[4]) : [],
        active: row[5],
        createdAt: row[6]
      });
    }
    
    return automations;
  } catch (error) {
    Logger.log('Error al obtener automatizaciones: ' + error.toString());
    return [];
  }
}

/**
 * Ejecutar acciones de automatización
 */
function executeAutomationActions(conversationId, actions) {
  try {
    for (const action of actions) {
      if (action.type === 'send_template') {
        const template = getTemplateById(action.templateId);
        if (template) {
          const conversation = getConversationById(conversationId);
          let content = template.content;
          
          // Reemplazar variables
          if (conversation) {
            content = content.replace('{{nombre}}', conversation.name);
          }
          
          sendMessage(conversationId, content, conversation.channel);
        }
      } else if (action.type === 'add_tag') {
        addTagToConversation(conversationId, action.tag);
      } else if (action.type === 'create_odoo_lead') {
        createOdooLead(conversationId);
      }
    }
  } catch (error) {
    Logger.log('Error al ejecutar acciones: ' + error.toString());
  }
}

/**
 * Obtener plantilla por ID
 */
function getTemplateById(id) {
  const templates = getMessageTemplates();
  return templates.find(tpl => tpl.id === id);
}

/**
 * Obtener plantillas de mensajes
 */
function getMessageTemplates() {
  try {
    const spreadsheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const sheet = spreadsheet.getSheetByName('Plantillas') || spreadsheet.insertSheet('Plantillas');
    
    // Crear plantillas por defecto si no existen
    if (sheet.getLastRow() <= 1) {
      sheet.getRange(1, 1, 1, 6).setValues([['ID', 'Nombre', 'Contenido', 'Canal', 'Variables', 'Estado']]);
      
      const defaultTemplates = [
        ['tpl_1', 'Bienvenida', 'Hola {{nombre}}, gracias por contactar con nosotros. ¿En qué podemos ayudarte?', 'whatsapp', 'nombre', 'activa'],
        ['tpl_2', 'Confirmación', 'Hola {{nombre}}, tu pedido #{{pedido}} ha sido confirmado.', 'whatsapp', 'nombre,pedido', 'activa'],
        ['tpl_3', 'Seguimiento', 'Esperamos que estés disfrutando de nuestro servicio. ¿Tienes algún comentario?', 'email', '', 'activa']
      ];
      
      sheet.getRange(2, 1, defaultTemplates.length, 6).setValues(defaultTemplates);
    }
    
    const data = sheet.getDataRange().getValues();
    const templates = [];
    
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      templates.push({
        id: row[0],
        name: row[1],
        content: row[2],
        channel: row[3],
        variables: row[4] ? row[4].split(',') : [],
        status: row[5]
      });
    }
    
    return templates;
  } catch (error) {
    Logger.log('Error al obtener plantillas: ' + error.toString());
    return [];
  }
}

/**
 * Añadir etiqueta a conversación
 */
function addTagToConversation(conversationId, tag) {
  try {
    const spreadsheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const sheet = spreadsheet.getSheetByName('Conversaciones');
    const data = sheet.getDataRange().getValues();
    
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === conversationId) {
        const currentTags = data[i][9] ? data[i][9].split(',') : [];
        if (!currentTags.includes(tag)) {
          currentTags.push(tag);
          sheet.getRange(i + 1, 10).setValue(currentTags.join(','));
        }
        break;
      }
    }
  } catch (error) {
    Logger.log('Error al añadir etiqueta: ' + error.toString());
  }
}

/**
 * Enviar SMS (simulado)
 */
function sendSMSMessage(conversationId, content) {
  // Implementación simulada para SMS
  Logger.log('Enviando SMS: ' + content);
  return true;
}

/**
 * Enviar Email
 */
function sendEmailMessage(conversationId, content) {
  try {
    const conversation = getConversationById(conversationId);
    if (!conversation || !conversation.email) {
      return false;
    }
    
    MailApp.sendEmail({
      to: conversation.email,
      subject: 'Respuesta de MultiChat',
      body: content
    });
    
    return true;
  } catch (error) {
    Logger.log('Error al enviar email: ' + error.toString());
    return false;
  }
}

/**
 * Función para configurar las propiedades del script
 */
function setupConfiguration() {
  const properties = PropertiesService.getScriptProperties();
  
  // Configurar aquí las propiedades necesarias
  properties.setProperties({
    'SPREADSHEET_ID': 'TU_SPREADSHEET_ID_AQUI',
    'ODOO_URL': 'https://tu-empresa.odoo.com',
    'ODOO_DB': 'tu_base_de_datos',
    'ODOO_USERNAME': 'tu_usuario_odoo',
    'ODOO_PASSWORD': 'tu_password_odoo',
    'WAZZUP_API_KEY': 'tu_api_key_de_wazzup',
    'WAZZUP_CHANNEL_ID': 'tu_channel_id_de_wazzup',
    'WEBHOOK_URL': 'https://script.google.com/macros/s/TU_SCRIPT_ID/exec'
  });
  
  Logger.log('Configuración guardada correctamente');
  
  // Crear hojas de datos si no existen
  createDataSheets();
  
  return 'Configuración guardada correctamente';
}

/**
 * Crear hojas de datos necesarias
 */
function createDataSheets() {
  try {
    const spreadsheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    
    // Crear hojas si no existen
    const sheets = [
      {
        name: 'Conversaciones',
        headers: [
          'ID', 'Nombre', 'Teléfono', 'Email', 'Canal', 'Último mensaje', 'Hora último mensaje', 
          'No leídos', 'Estado', 'Etiquetas', 'Creado', 'Agente asignado', 'Asignado en', 'Odoo Partner ID', 'Datos adicionales'
        ]
      },
      {
        name: 'Mensajes',
        headers: [
          'ID', 'Conversación ID', 'Contenido', 'Remitente', 'Timestamp', 'Estado', 'Tipo', 'Wazzup ID'
        ]
      },
      {
        name: 'Agentes',
        headers: [
          'ID', 'Nombre', 'Email', 'Equipo', 'Estado', 'Conversaciones', 'Última actividad'
        ]
      },
      {
        name: 'Transferencias',
        headers: [
          'ID', 'Conversación ID', 'Agente Anterior', 'Agente Nuevo', 'Motivo', 'Fecha', 'Notas'
        ]
      },
      {
        name: 'Plantillas',
        headers: [
          'ID', 'Nombre', 'Contenido', 'Canal', 'Variables', 'Estado'
        ]
      },
      {
        name: 'Automatizaciones',
        headers: [
          'ID', 'Nombre', 'Descripción', 'Trigger', 'Acciones', 'Activa', 'Creada'
        ]
      },
      {
        name: 'Actividades',
        headers: [
          'ID', 'Conversación ID', 'Tipo', 'Datos', 'Fecha'
        ]
      }
    ];
    
    for (const sheetInfo of sheets) {
      const sheet = spreadsheet.getSheetByName(sheetInfo.name) || spreadsheet.insertSheet(sheetInfo.name);
      
      if (sheet.getLastRow() === 0) {
        sheet.getRange(1, 1, 1, sheetInfo.headers.length).setValues([sheetInfo.headers]);
        sheet.getRange(1, 1, 1, sheetInfo.headers.length).setFontWeight('bold');
        sheet.setFrozenRows(1);
      }
    }
    
    Logger.log('Hojas de datos creadas correctamente');
  } catch (error) {
    Logger.log('Error al crear hojas de datos: ' + error.toString());
  }
}

/**
 * Función de prueba para Odoo
 */
function testOdooConnection() {
  try {
    const uid = authenticateOdoo();
    Logger.log('Conexión Odoo exitosa. UID: ' + uid);
    
    // Probar búsqueda de contactos
    const partners = callOdooRPC('res.partner', 'search_read', [
      [['is_company', '=', false]]
    ], {
      fields: ['name', 'email', 'mobile'],
      limit: 5
    });
    
    Logger.log('Contactos encontrados: ' + partners.length);
    return { success: true, uid: uid, partnersCount: partners.length };
  } catch (error) {
    Logger.log('Error en prueba de Odoo: ' + error.toString());
    return { success: false, error: error.toString() };
  }
}

/**
 * Función de prueba para Wazzup
 */
function testWazzupConnection() {
  try {
    const options = {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + CONFIG.WAZZUP_API_KEY
      }
    };

    const response = UrlFetchApp.fetch('https://api.wazzup24.com/v3/channels', options);
    const result = JSON.parse(response.getContentText());

    if (response.getResponseCode() === 200) {
      Logger.log('Conexión Wazzup exitosa. Canales: ' + result.length);
      return { success: true, channels: result };
    } else {
      throw new Error('Error en conexión: ' + result.message);
    }
  } catch (error) {
    Logger.log('Error en prueba de Wazzup: ' + error.toString());
    return { success: false, error: error.toString() };
  }
}

/**
 * Crear datos de ejemplo para pruebas
 */
function createSampleData() {
  try {
    // Crear agentes de ejemplo
    const spreadsheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const agentsSheet = spreadsheet.getSheetByName('Agentes');
    
    if (agentsSheet.getLastRow() <= 1) {
      const defaultAgents = [
        ['agent_1', 'Juan Pérez', 'juan@empresa.com', 'Ventas', 'disponible', 0, new Date()],
        ['agent_2', 'María González', 'maria@empresa.com', 'Soporte', 'disponible', 0, new Date()],
        ['agent_3', 'Carlos Rodríguez', 'carlos@empresa.com', 'Ventas', 'ocupado', 3, new Date()]
      ];
      
      agentsSheet.getRange(2, 1, defaultAgents.length, 7).setValues(defaultAgents);
    }
    
    // Crear conversaciones de ejemplo
    const conversationsSheet = spreadsheet.getSheetByName('Conversaciones');
    
    if (conversationsSheet.getLastRow() <= 1) {
      const defaultConversations = [
        [
          'conv_1', 
          'Carlos Cliente', 
          '+34612345678', 
          'carlos@cliente.com', 
          'whatsapp', 
          'Hola, necesito información sobre sus servicios', 
          new Date().toISOString(), 
          2, 
          'active', 
          'nuevo,interesado', 
          new Date(new Date().getTime() - 24*60*60*1000).toISOString(), 
          'agent_1', 
          new Date(new Date().getTime() - 23*60*60*1000).toISOString(), 
          null, 
          '{}'
        ],
        [
          'conv_2', 
          'María Usuaria', 
          '+34623456789', 
          'maria@usuaria.com', 
          'sms', 
          'Gracias por su atención', 
          new Date().toISOString(), 
          0, 
          'active', 
          'cliente', 
          new Date(new Date().getTime() - 48*60*60*1000).toISOString(), 
          'agent_2', 
          new Date(new Date().getTime() - 47*60*60*1000).toISOString(), 
          null, 
          '{}'
        ]
      ];
      
      conversationsSheet.getRange(2, 1, defaultConversations.length, 15).setValues(defaultConversations);
    }
    
    // Crear mensajes de ejemplo
    const messagesSheet = spreadsheet.getSheetByName('Mensajes');
    
    if (messagesSheet.getLastRow() <= 1) {
      const defaultMessages = [
        [
          'msg_1', 
          'conv_1', 
          'Hola, necesito información sobre sus servicios', 
          'contact', 
          new Date(new Date().getTime() - 24*60*60*1000).toISOString(), 
          'read', 
          'text', 
          null
        ],
        [
          'msg_2', 
          'conv_1', 
          'Claro, estaré encantado de ayudarte. ¿Qué tipo de servicios te interesan?', 
          'user', 
          new Date(new Date().getTime() - 23*60*60*1000).toISOString(), 
          'delivered', 
          'text', 
          'wazzup_123'
        ],
        [
          'msg_3', 
          'conv_2', 
          'Hola, ¿podría confirmarme si mi pedido ya ha sido enviado?', 
          'contact', 
          new Date(new Date().getTime() - 48*60*60*1000).toISOString(), 
          'read', 
          'text', 
          null
        ],
        [
          'msg_4', 
          'conv_2', 
          'Buenas tardes María. Sí, su pedido #45678 fue enviado ayer. Debería recibirlo en 24-48 horas.', 
          'user', 
          new Date(new Date().getTime() - 47*60*60*1000).toISOString(), 
          'delivered', 
          'text', 
          'wazzup_456'
        ],
        [
          'msg_5', 
          'conv_2', 
          'Gracias por su atención', 
          'contact', 
          new Date(new Date().getTime() - 46*60*60*1000).toISOString(), 
          'read', 
          'text', 
          null
        ]
      ];
      
      messagesSheet.getRange(2, 1, defaultMessages.length, 8).setValues(defaultMessages);
    }
    
    // Crear plantillas de ejemplo
    const templatesSheet = spreadsheet.getSheetByName('Plantillas');
    
    if (templatesSheet.getLastRow() <= 1) {
      const defaultTemplates = [
        ['tpl_1', 'Bienvenida', 'Hola {{nombre}}, gracias por contactar con nosotros. ¿En qué podemos ayudarte?', 'whatsapp', 'nombre', 'activa'],
        ['tpl_2', 'Confirmación', 'Hola {{nombre}}, tu pedido #{{pedido}} ha sido confirmado.', 'whatsapp', 'nombre,pedido', 'activa'],
        ['tpl_3', 'Seguimiento', 'Esperamos que estés disfrutando de nuestro servicio. ¿Tienes algún comentario?', 'email', '', 'activa']
      ];
      
      templatesSheet.getRange(2, 1, defaultTemplates.length, 6).setValues(defaultTemplates);
    }
    
    return 'Datos de ejemplo creados correctamente';
  } catch (error) {
    Logger.log('Error al crear datos de ejemplo: ' + error.toString());
    return 'Error al crear datos de ejemplo: ' + error.toString();
  }
}

/**
 * Obtener configuración actual
 */
function getConfiguration() {
  return {
    SPREADSHEET_ID: CONFIG.SPREADSHEET_ID,
    ODOO_URL: CONFIG.ODOO_URL,
    ODOO_DB: CONFIG.ODOO_DB,
    WAZZUP_API_KEY: CONFIG.WAZZUP_API_KEY,
    WAZZUP_CHANNEL_ID: CONFIG.WAZZUP_CHANNEL_ID
  };
}

/**
 * Guardar configuración inicial
 */
function saveInitialConfiguration(spreadsheetId) {
  try {
    const properties = PropertiesService.getScriptProperties();
    properties.setProperty('SPREADSHEET_ID', spreadsheetId);
    
    // Actualizar CONFIG global
    CONFIG.SPREADSHEET_ID = spreadsheetId;
    
    // Crear hojas de datos
    createDataSheets();
    
    // Crear datos de ejemplo
    createSampleData();
    
    return { success: true };
  } catch (error) {
    Logger.log('Error al guardar configuración inicial: ' + error.toString());
    return { success: false, error: error.toString() };
  }
}

/**
 * Crear spreadsheet de ejemplo
 */
function createSampleSpreadsheet() {
  try {
    const spreadsheet = SpreadsheetApp.create('MultiChat - Datos');
    const spreadsheetId = spreadsheet.getId();
    
    // Guardar en propiedades
    const properties = PropertiesService.getScriptProperties();
    properties.setProperty('SPREADSHEET_ID', spreadsheetId);
    
    // Actualizar CONFIG global
    CONFIG.SPREADSHEET_ID = spreadsheetId;
    
    // Crear hojas de datos
    createDataSheets();
    
    // Crear datos de ejemplo
    createSampleData();
    
    return { success: true, spreadsheetId: spreadsheetId };
  } catch (error) {
    Logger.log('Error al crear spreadsheet: ' + error.toString());
    return { success: false, error: error.toString() };
  }
}

/**
 * Guardar plantilla
 */
function saveTemplate(templateData) {
  try {
    const spreadsheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const sheet = spreadsheet.getSheetByName('Plantillas');
    
    const templateId = Utilities.getUuid();
    sheet.appendRow([
      templateId,
      templateData.name,
      templateData.content,
      templateData.channel,
      templateData.variables.join(','),
      'activa'
    ]);
    
    return { success: true, templateId: templateId };
  } catch (error) {
    Logger.log('Error al guardar plantilla: ' + error.toString());
    return { success: false, error: error.toString() };
  }
}

/**
 * Guardar configuración de Odoo
 */
function saveOdooConfiguration(configData) {
  try {
    const properties = PropertiesService.getScriptProperties();
    properties.setProperties({
      'ODOO_URL': configData.url,
      'ODOO_DB': configData.db,
      'ODOO_USERNAME': configData.username,
      'ODOO_PASSWORD': configData.password
    });
    
    // Actualizar CONFIG global
    CONFIG.ODOO_URL = configData.url;
    CONFIG.ODOO_DB = configData.db;
    CONFIG.ODOO_USERNAME = configData.username;
    CONFIG.ODOO_PASSWORD = configData.password;
    
    // Probar conexión
    const testResult = testOdooConnection();
    
    return testResult;
  } catch (error) {
    Logger.log('Error al guardar configuración de Odoo: ' + error.toString());
    return { success: false, error: error.toString() };
  }
}

/**
 * Guardar configuración de Wazzup
 */
function saveWazzupConfiguration(configData) {
  try {
    const properties = PropertiesService.getScriptProperties();
    properties.setProperties({
      'WAZZUP_API_KEY': configData.apiKey,
      'WAZZUP_CHANNEL_ID': configData.channelId
    });
    
    // Actualizar CONFIG global
    CONFIG.WAZZUP_API_KEY = configData.apiKey;
    CONFIG.WAZZUP_CHANNEL_ID = configData.channelId;
    
    // Configurar webhook
    const webhookResult = setupWazzupWebhook();
    
    return webhookResult;
  } catch (error) {
    Logger.log('Error al guardar configuración de Wazzup: ' + error.toString());
    return { success: false, error: error.toString() };
  }
}

/**
 * Corregir función createSampleData que tenía un error de sintaxis
 */
function createSampleData() {
  try {
    // Crear agentes de ejemplo
    const spreadsheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const agentsSheet = spreadsheet.getSheetByName('Agentes');
    
    if (agentsSheet.getLastRow() <= 1) {
      const defaultAgents = [
        ['agent_1', 'Juan Pérez', 'juan@empresa.com', 'Ventas', 'disponible', 0, new Date()],
        ['agent_2', 'María González', 'maria@empresa.com', 'Soporte', 'disponible', 0, new Date()],
        ['agent_3', 'Carlos Rodríguez', 'carlos@empresa.com', 'Ventas', 'ocupado', 3, new Date()]
      ];
      
      agentsSheet.getRange(2, 1, defaultAgents.length, 7).setValues(defaultAgents);
    }
    
    // Crear conversaciones de ejemplo
    const conversationsSheet = spreadsheet.getSheetByName('Conversaciones');
    
    if (conversationsSheet.getLastRow() <= 1) {
      const defaultConversations = [
        [
          'conv_1', 
          'Carlos Cliente', 
          '+34612345678', 
          'carlos@cliente.com', 
          'whatsapp', 
          'Hola, necesito información sobre sus servicios', 
          new Date().toISOString(), 
          2, 
          'active', 
          'nuevo,interesado', 
          new Date(new Date().getTime() - 24*60*60*1000).toISOString(), 
          'agent_1', 
          new Date(new Date().getTime() - 23*60*60*1000).toISOString(), 
          null, 
          '{}'
        ],
        [
          'conv_2', 
          'María Usuaria', 
          '+34623456789', 
          'maria@usuaria.com', 
          'sms', 
          'Gracias por su atención', 
          new Date().toISOString(), 
          0, 
          'active', 
          'cliente', 
          new Date(new Date().getTime() - 48*60*60*1000).toISOString(), 
          'agent_2', 
          new Date(new Date().getTime() - 47*60*60*1000).toISOString(), 
          null, 
          '{}'
        ]
      ];
      
      conversationsSheet.getRange(2, 1, defaultConversations.length, 15).setValues(defaultConversations);
    }
    
    // Crear mensajes de ejemplo
    const messagesSheet = spreadsheet.getSheetByName('Mensajes');
    
    if (messagesSheet.getLastRow() <= 1) {
      const defaultMessages = [
        [
          'msg_1', 
          'conv_1', 
          'Hola, necesito información sobre sus servicios', 
          'contact', 
          new Date(new Date().getTime() - 24*60*60*1000).toISOString(), 
          'read', 
          'text', 
          null
        ],
        [
          'msg_2', 
          'conv_1', 
          'Claro, estaré encantado de ayudarte. ¿Qué tipo de servicios te interesan?', 
          'user', 
          new Date(new Date().getTime() - 23*60*60*1000).toISOString(), 
          'delivered', 
          'text', 
          'wazzup_123'
        ],
        [
          'msg_3', 
          'conv_2', 
          'Hola, ¿podría confirmarme si mi pedido ya ha sido enviado?', 
          'contact', 
          new Date(new Date().getTime() - 48*60*60*1000).toISOString(), 
          'read', 
          'text', 
          null
        ],
        [
          'msg_4', 
          'conv_2', 
          'Buenas tardes María. Sí, su pedido #45678 fue enviado ayer. Debería recibirlo en 24-48 horas.', 
          'user', 
          new Date(new Date().getTime() - 47*60*60*1000).toISOString(), 
          'delivered', 
          'text', 
          'wazzup_456'
        ],
        [
          'msg_5', 
          'conv_2', 
          'Gracias por su atención', 
          'contact', 
          new Date(new Date().getTime() - 46*60*60*1000).toISOString(), 
          'read', 
          'text', 
          null
        ]
      ];
      
      messagesSheet.getRange(2, 1, defaultMessages.length, 8).setValues(defaultMessages);
    }
    
    // Crear plantillas de ejemplo
    const templatesSheet = spreadsheet.getSheetByName('Plantillas');
    
    if (templatesSheet.getLastRow() <= 1) {
      const defaultTemplates = [
        ['tpl_1', 'Bienvenida', 'Hola {{nombre}}, gracias por contactar con nosotros. ¿En qué podemos ayudarte?', 'whatsapp', 'nombre', 'activa'],
        ['tpl_2', 'Confirmación', 'Hola {{nombre}}, tu pedido #{{pedido}} ha sido confirmado.', 'whatsapp', 'nombre,pedido', 'activa'],
        ['tpl_3', 'Seguimiento', 'Esperamos que estés disfrutando de nuestro servicio. ¿Tienes algún comentario?', 'email', '', 'activa']
      ];
      
      templatesSheet.getRange(2, 1, defaultTemplates.length, 6).setValues(defaultTemplates);
    }
    
    return 'Datos de ejemplo creados correctamente';
  } catch (error) {
    Logger.log('Error al crear datos de ejemplo: ' + error.toString());
    return 'Error al crear datos de ejemplo: ' + error.toString();
  }
}


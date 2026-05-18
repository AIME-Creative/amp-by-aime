/**
 * GoHighLevel (GHL) API Client
 * Handles creating opportunities and contacts in GHL CRM
 */

interface GHLContact {
  firstName: string
  lastName: string
  name?: string
  email: string
  phone?: string
  customFields?: Record<string, string>
  tags?: string[]
}

interface GHLContactResponse {
  id: string
  firstName?: string
  lastName?: string
  email?: string
  phone?: string
  tags?: string[]
}

interface GHLOpportunity {
  pipelineId: string
  stageId: string
  name: string
  contactId: string
  monetaryValue?: number
  status: string
  customFields?: Record<string, any>
}

interface CreateOpportunityParams {
  type: 'lender_connection' | 'vendor_connection' | 'change_ae' | 'loan_escalation'
  contact: {
    fullName: string
    email: string
    phone?: string
    nmlsNumber?: string
    stateLicenses?: string[]
  }
  details: Record<string, any>
}

interface GHLResponse {
  success: boolean
  contactId?: string
  opportunityId?: string
  error?: string
}

class GHLClient {
  private apiKey: string
  private apiUrl: string
  private locationId: string

  // Pipeline and stage IDs - these should be configured in environment variables
  private readonly pipelineIds = {
    opportunities: process.env.GHL_OPPORTUNITIES_PIPELINE_ID || '',
  }

  private readonly stageIds = {
    lender_connection: process.env.GHL_STAGE_LENDER_CONNECTION || '',
    vendor_connection: process.env.GHL_STAGE_VENDOR_CONNECTION || '',
    change_ae: process.env.GHL_STAGE_CHANGE_AE || '',
    loan_escalation: process.env.GHL_STAGE_LOAN_ESCALATION || '',
  }

  constructor() {
    this.apiKey = process.env.GHL_PRIVATE_KEY || process.env.GOHIGHLEVEL_API_KEY || process.env.GHL_API_KEY || ''
    this.apiUrl = 'https://services.leadconnectorhq.com'
    this.locationId = process.env.GHL_LOCATION_ID || process.env.GOHIGHLEVEL_LOCATION_ID || ''

    if (!this.apiKey) {
      console.warn('GHL_PRIVATE_KEY not configured')
    }
  }

  /**
   * Create or update a contact in GHL
   */
  private async createOrUpdateContact(contactData: GHLContact): Promise<string> {
    try {
      const payload: Record<string, any> = {
        locationId: this.locationId,
        firstName: contactData.firstName,
        lastName: contactData.lastName,
        name: contactData.name || `${contactData.firstName} ${contactData.lastName}`.trim(),
        email: contactData.email,
        phone: contactData.phone,
        customFields: contactData.customFields,
      }

      // Add tags if provided
      if (contactData.tags && contactData.tags.length > 0) {
        payload.tags = contactData.tags
      }

      const response = await fetch(`${this.apiUrl}/contacts/`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'Version': '2021-07-28',
        },
        body: JSON.stringify(payload),
      })

      if (!response.ok) {
        const error = await response.text()
        throw new Error(`Failed to create contact: ${error}`)
      }

      const data = await response.json()
      return data.contact?.id || data.id
    } catch (error) {
      console.error('Error creating GHL contact:', error)
      throw error
    }
  }

  /**
   * Public method to upsert a contact in GHL (for vendors/lenders)
   */
  async upsertContact(contactData: {
    firstName: string
    lastName: string
    email: string
    phone?: string
    companyName?: string
    role?: string
    customFields?: Record<string, string>
  }): Promise<{ success: boolean; contactId?: string; error?: string }> {
    try {
      // If API key is not configured, return mock success for development
      if (!this.apiKey) {
        console.warn('GHL API not configured, skipping contact upsert')
        return {
          success: true,
          contactId: 'mock_contact_id',
        }
      }

      // Merge custom fields with role and company
      const customFields = {
        ...contactData.customFields,
        ...(contactData.companyName && { company_name: contactData.companyName }),
        ...(contactData.role && { user_role: contactData.role }),
      }

      // Build full name for GHL's name field
      const fullName = `${contactData.firstName} ${contactData.lastName}`.trim()

      const contactId = await this.createOrUpdateContact({
        firstName: contactData.firstName,
        lastName: contactData.lastName,
        name: fullName,
        email: contactData.email,
        phone: contactData.phone,
        customFields,
      })

      return {
        success: true,
        contactId,
      }
    } catch (error) {
      console.error('Error upserting GHL contact:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  /**
   * Update an existing contact in GHL by contact ID
   */
  async updateContact(
    contactId: string,
    contactData: {
      firstName?: string
      lastName?: string
      email?: string
      phone?: string
      companyName?: string
      role?: string
      customFields?: Record<string, string>
    }
  ): Promise<{ success: boolean; contactId?: string; error?: string }> {
    try {
      // If API key is not configured, return mock success for development
      if (!this.apiKey) {
        console.warn('GHL API not configured, skipping contact update')
        return {
          success: true,
          contactId,
        }
      }

      // Build the update payload
      const updatePayload: Record<string, any> = {}

      if (contactData.firstName !== undefined) {
        updatePayload.firstName = contactData.firstName
      }
      if (contactData.lastName !== undefined) {
        updatePayload.lastName = contactData.lastName
      }
      if (contactData.email !== undefined) {
        updatePayload.email = contactData.email
      }
      if (contactData.phone !== undefined) {
        updatePayload.phone = contactData.phone
      }

      // Merge custom fields with role and company
      const customFields: Record<string, string> = {
        ...contactData.customFields,
      }
      if (contactData.companyName) {
        customFields.company_name = contactData.companyName
      }
      if (contactData.role) {
        customFields.user_role = contactData.role
      }

      if (Object.keys(customFields).length > 0) {
        updatePayload.customFields = customFields
      }

      const response = await fetch(`${this.apiUrl}/contacts/${contactId}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'Version': '2021-07-28',
        },
        body: JSON.stringify(updatePayload),
      })

      if (!response.ok) {
        const error = await response.text()
        throw new Error(`Failed to update contact: ${error}`)
      }

      const data = await response.json()
      return {
        success: true,
        contactId: data.contact?.id || contactId,
      }
    } catch (error) {
      console.error('Error updating GHL contact:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  /**
   * Find a contact by email using search endpoint
   */
  async findContactByEmail(email: string): Promise<GHLContactResponse | null> {
    try {
      if (!this.apiKey || !email) {
        return null
      }

      const response = await fetch(`${this.apiUrl}/contacts/search`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'Version': '2021-07-28',
        },
        body: JSON.stringify({
          locationId: this.locationId,
          page: 1,
          pageLimit: 1,
          filters: [{
            group: 'OR',
            filters: [{ field: 'email', operator: 'eq', value: email }]
          }]
        })
      })

      if (!response.ok) {
        const error = await response.text()
        console.error('Error finding contact by email:', error)
        return null
      }

      const data = await response.json()
      return data.contacts?.[0] || null
    } catch (error) {
      console.error('Error finding GHL contact by email:', error)
      return null
    }
  }

  /**
   * Find a contact by phone number using search endpoint
   */
  async findContactByPhone(phone: string): Promise<GHLContactResponse | null> {
    try {
      if (!this.apiKey || !phone) {
        return null
      }

      // Normalize phone number - remove non-digits
      const normalizedPhone = phone.replace(/\D/g, '')

      const response = await fetch(`${this.apiUrl}/contacts/search`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'Version': '2021-07-28',
        },
        body: JSON.stringify({
          locationId: this.locationId,
          page: 1,
          pageLimit: 1,
          filters: [{
            group: 'OR',
            filters: [{ field: 'phone', operator: 'eq', value: normalizedPhone }]
          }]
        })
      })

      if (!response.ok) {
        const error = await response.text()
        console.error('Error finding contact by phone:', error)
        return null
      }

      const data = await response.json()
      return data.contacts?.[0] || null
    } catch (error) {
      console.error('Error finding GHL contact by phone:', error)
      return null
    }
  }

  /**
   * Add a tag to a contact
   */
  async addTagToContact(contactId: string, tag: string): Promise<boolean> {
    try {
      if (!this.apiKey || !contactId || !tag) {
        return false
      }

      const response = await fetch(`${this.apiUrl}/contacts/${contactId}/tags`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'Version': '2021-07-28',
        },
        body: JSON.stringify({
          tags: [tag],
        }),
      })

      if (!response.ok) {
        const error = await response.text()
        console.error('Error adding tag to contact:', error)
        return false
      }

      return true
    } catch (error) {
      console.error('Error adding tag to GHL contact:', error)
      return false
    }
  }

  /**
   * POST a Fuse registration → Opportunity payload to an AIME-owned
   * webhook URL (env: GHL_FUSE_OPPORTUNITY_WEBHOOK_URL). The webhook
   * receiver is responsible for creating / updating the GHL Opportunity
   * and mapping fields to the right pipeline / stage. Our job is just to
   * send a stable payload shape.
   */
  async postFuseOpportunity(payload: Record<string, unknown>): Promise<boolean> {
    const url = process.env.GHL_FUSE_OPPORTUNITY_WEBHOOK_URL
    if (!url) {
      console.warn('GHL_FUSE_OPPORTUNITY_WEBHOOK_URL not configured; skipping opportunity push')
      return false
    }
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!response.ok) {
        const error = await response.text()
        console.error('Error posting Fuse opportunity webhook:', response.status, error)
        return false
      }
      return true
    } catch (error) {
      console.error('Error posting Fuse opportunity webhook:', error)
      return false
    }
  }

  /**
   * Remove a tag from a contact
   */
  async removeTagFromContact(contactId: string, tag: string): Promise<boolean> {
    try {
      if (!this.apiKey || !contactId || !tag) {
        return false
      }

      const response = await fetch(`${this.apiUrl}/contacts/${contactId}/tags`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'Version': '2021-07-28',
        },
        body: JSON.stringify({
          tags: [tag],
        }),
      })

      if (!response.ok) {
        const error = await response.text()
        console.error('Error removing tag from contact:', error)
        return false
      }

      return true
    } catch (error) {
      console.error('Error removing tag from GHL contact:', error)
      return false
    }
  }

  /**
   * Find or create a contact and add a tag
   * Flow: Find by email -> Find by phone -> Create new
   * Then add the specified tag
   */
  async findOrCreateContactWithTag(contactData: {
    name: string
    email: string
    phone: string
    companyName?: string
    tag: string
  }): Promise<{ success: boolean; contactId?: string; error?: string; isNew?: boolean }> {
    try {
      // If API key is not configured, return mock success for development
      if (!this.apiKey) {
        console.warn('GHL API not configured, skipping contact sync')
        return {
          success: true,
          contactId: 'mock_contact_id',
          isNew: false,
        }
      }

      let contact: GHLContactResponse | null = null
      let isNew = false

      // Step 1: Try to find by email
      if (contactData.email) {
        contact = await this.findContactByEmail(contactData.email)
      }

      // Step 2: If not found, try to find by phone
      if (!contact && contactData.phone) {
        contact = await this.findContactByPhone(contactData.phone)
      }

      // Step 3: If still not found, create new contact
      if (!contact) {
        // Parse name into first and last name
        const nameParts = contactData.name.trim().split(' ')
        const firstName = nameParts[0] || ''
        const lastName = nameParts.slice(1).join(' ') || ''

        const contactId = await this.createOrUpdateContact({
          firstName,
          lastName,
          name: contactData.name,
          email: contactData.email,
          phone: contactData.phone,
          customFields: contactData.companyName ? { company_name: contactData.companyName } : undefined,
          tags: [contactData.tag],
        })

        return {
          success: true,
          contactId,
          isNew: true,
        }
      }

      // Step 4: Contact found, add the tag
      const tagAdded = await this.addTagToContact(contact.id, contactData.tag)
      if (!tagAdded) {
        console.warn(`Failed to add tag "${contactData.tag}" to contact ${contact.id}`)
      }

      return {
        success: true,
        contactId: contact.id,
        isNew: false,
      }
    } catch (error) {
      console.error('Error in findOrCreateContactWithTag:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  /**
   * Create an opportunity in GHL
   */
  private async createOpportunity(opportunityData: GHLOpportunity): Promise<string> {
    try {
      const response = await fetch(`${this.apiUrl}/opportunities/`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'Version': '2021-07-28',
        },
        body: JSON.stringify({
          locationId: this.locationId,
          ...opportunityData,
        }),
      })

      if (!response.ok) {
        const error = await response.text()
        throw new Error(`Failed to create opportunity: ${error}`)
      }

      const data = await response.json()
      return data.opportunity?.id || data.id
    } catch (error) {
      console.error('Error creating GHL opportunity:', error)
      throw error
    }
  }

  /**
   * Main method to create an opportunity with contact
   */
  async createOpportunityWithContact(params: CreateOpportunityParams): Promise<GHLResponse> {
    try {
      // If API key is not configured, return mock success for development
      if (!this.apiKey) {
        console.warn('GHL API not configured, skipping opportunity creation')
        return {
          success: true,
          contactId: 'mock_contact_id',
          opportunityId: 'mock_opportunity_id',
        }
      }

      // Create or update contact
      const customFields: Record<string, string> = {}
      if (params.contact.nmlsNumber) {
        customFields.nmls_number = params.contact.nmlsNumber
      }
      if (params.contact.stateLicenses) {
        customFields.state_licenses = params.contact.stateLicenses.join(', ')
      }

      // Parse fullName into first and last name
      const nameParts = params.contact.fullName.trim().split(' ')
      const firstName = nameParts[0] || ''
      const lastName = nameParts.slice(1).join(' ') || ''

      const contactId = await this.createOrUpdateContact({
        firstName,
        lastName,
        name: params.contact.fullName,
        email: params.contact.email,
        phone: params.contact.phone,
        customFields,
      })

      // Create opportunity
      const opportunityName = this.getOpportunityName(params.type, params.details)
      const stageId = this.stageIds[params.type]

      if (!stageId) {
        throw new Error(`Stage ID not configured for type: ${params.type}`)
      }

      const opportunityId = await this.createOpportunity({
        pipelineId: this.pipelineIds.opportunities,
        stageId,
        name: opportunityName,
        contactId,
        status: 'open',
        customFields: params.details,
      })

      return {
        success: true,
        contactId,
        opportunityId,
      }
    } catch (error) {
      console.error('Error in createOpportunityWithContact:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  /**
   * Generate opportunity name based on type and details
   */
  private getOpportunityName(type: string, details: Record<string, any>): string {
    const timestamp = new Date().toLocaleDateString()

    switch (type) {
      case 'lender_connection':
        return `Lender Connection - ${details.lender_name || 'Unknown'} - ${timestamp}`
      case 'vendor_connection':
        return `Vendor Connection - ${details.vendor_name || 'Unknown'} - ${timestamp}`
      case 'change_ae':
        return `Change AE Request - ${details.lender_name || 'Unknown'} - ${timestamp}`
      case 'loan_escalation':
        return `Loan Escalation - ${details.partner_name || 'Unknown'} - ${timestamp}`
      default:
        return `Opportunity - ${timestamp}`
    }
  }

  /**
   * Sync full profile to GHL (create or update)
   * Uses find-first approach: email lookup -> create/update
   */
  async syncFullProfile(profileData: {
    firstName: string
    lastName: string
    name: string
    email: string
    phone?: string
    address1?: string
    city?: string
    state?: string
    postalCode?: string
    companyName?: string
    dateOfBirth?: string
    customFields: Record<string, string>
  }): Promise<{ success: boolean; contactId?: string; error?: string }> {
    try {
      // If API key is not configured, return mock success for development
      if (!this.apiKey) {
        console.warn('GHL API not configured, skipping profile sync')
        return {
          success: true,
          contactId: 'mock_contact_id',
        }
      }

      // First, try to find existing contact by email
      const existingContact = await this.findContactByEmail(profileData.email)

      // Build the payload
      const payload: Record<string, any> = {
        locationId: this.locationId,
        firstName: profileData.firstName,
        lastName: profileData.lastName,
        name: profileData.name,
        email: profileData.email,
        phone: profileData.phone,
        address1: profileData.address1,
        city: profileData.city,
        state: profileData.state,
        postalCode: profileData.postalCode,
        companyName: profileData.companyName,
        dateOfBirth: profileData.dateOfBirth,
        customFields: profileData.customFields,
      }

      // Remove undefined/null values
      Object.keys(payload).forEach(key => {
        if (payload[key] === undefined || payload[key] === null || payload[key] === '') {
          delete payload[key]
        }
      })

      let response: Response
      let contactId: string

      if (existingContact) {
        // Update existing contact
        response = await fetch(`${this.apiUrl}/contacts/${existingContact.id}`, {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            'Version': '2021-07-28',
          },
          body: JSON.stringify(payload),
        })
        contactId = existingContact.id
      } else {
        // Create new contact
        response = await fetch(`${this.apiUrl}/contacts/`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            'Version': '2021-07-28',
          },
          body: JSON.stringify(payload),
        })

        if (!response.ok) {
          const error = await response.text()
          throw new Error(`Failed to create contact: ${error}`)
        }

        const data = await response.json()
        contactId = data.contact?.id || data.id
      }

      if (!response.ok) {
        const error = await response.text()
        throw new Error(`Failed to sync contact: ${error}`)
      }

      console.log(`GHL profile synced for ${profileData.email}, contactId: ${contactId}`)

      return {
        success: true,
        contactId,
      }
    } catch (error) {
      console.error('Error syncing profile to GHL:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }
}

// Export singleton instance
export const ghlClient = new GHLClient()

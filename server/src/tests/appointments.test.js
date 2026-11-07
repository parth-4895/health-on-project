const request = require('supertest');
const app = require('../app');
const supabaseAdmin = require('../config/supabaseAdminClient');
const { createAndSendInvite } = require('../services/invite.service');
const { ok, mockTables, profileRow } = require('./helpers/supabaseMock');

jest.mock('../config/supabaseAdminClient', () => ({
  auth: {
    getUser: jest.fn(),
    admin: { listUsers: jest.fn() },
  },
  from: jest.fn(),
}));

jest.mock('../services/invite.service', () => ({
  createAndSendInvite: jest.fn(),
}));

describe('Appointments API', () => {
  const mockUser = { id: 'user-123', email: 'test@example.com' };
  const mockToken = 'valid-token';

  const send = (method, path) =>
    request(app)[method](path).set('Authorization', `Bearer ${mockToken}`);

  beforeEach(() => {
    jest.clearAllMocks();

    supabaseAdmin.auth.getUser.mockResolvedValue({ data: { user: mockUser }, error: null });

    // No existing account for the invited email unless a test says otherwise.
    supabaseAdmin.auth.admin.listUsers.mockResolvedValue({ data: { users: [] }, error: null });
    createAndSendInvite.mockResolvedValue({ id: 'invite-1', inviteLink: 'http://localhost:5173/invite/tok', emailSent: true });
  });

  describe('POST /appointments', () => {
    const validPayload = {
      patientEmail: 'patient@example.com',
      patientFullName: 'Patient Test',
      scheduledAt: '2026-10-01T10:00:00Z',
    };

    it('should create an invited appointment for a new patient', async () => {
      const mockCreatedAppointment = { id: 'appt-123', status: 'invited' };
      const chains = mockTables(supabaseAdmin, {
        profiles: profileRow('clinician'),
        appointments: ok(mockCreatedAppointment),
      });

      const response = await send('post', '/api/appointments').send(validPayload);

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        ...mockCreatedAppointment,
        isReturningPatient: false,
        inviteLink: 'http://localhost:5173/invite/tok',
        inviteEmailSent: true,
      });
      expect(chains.appointments[0].insert).toHaveBeenCalledWith(
        expect.objectContaining({ clinician_id: mockUser.id, patient_id: null, status: 'invited' })
      );
      expect(createAndSendInvite).toHaveBeenCalledWith({
        appointmentId: 'appt-123',
        patientEmail: validPayload.patientEmail,
        patientFullName: validPayload.patientFullName,
      });
    });

    it('reports when an invite link was created but email delivery failed', async () => {
      mockTables(supabaseAdmin, {
        profiles: profileRow('clinician'),
        appointments: ok({ id: 'appt-123', status: 'invited' }),
      });
      createAndSendInvite.mockResolvedValue({ id: 'invite-1', inviteLink: 'http://localhost:5173/invite/tok', emailSent: false });
      const response = await send('post', '/api/appointments').send(validPayload);
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ inviteEmailSent: false, inviteLink: 'http://localhost:5173/invite/tok' });
    });

    it('links a returning patient straight away when their account exists', async () => {
      supabaseAdmin.auth.admin.listUsers.mockResolvedValue({
        data: { users: [{ id: 'patient-9', email: 'Patient@Example.com' }] },
        error: null,
      });
      const chains = mockTables(supabaseAdmin, {
        // authGuard's read, then the returning patient's profile lookup.
        profiles: [profileRow('clinician'), ok({ id: 'patient-9', role: 'patient' })],
        // The "already treating?" check finds nothing, then the insert of the active appointment
        appointments: [ok([]), ok({ id: 'appt-7', status: 'active' })],
      });

      const response = await send('post', '/api/appointments').send(validPayload);

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ isReturningPatient: true, patientLinked: true });
      expect(chains.appointments[1].insert).toHaveBeenCalledWith(
        expect.objectContaining({ patient_id: 'patient-9', status: 'active' })
      );
      expect(createAndSendInvite).toHaveBeenCalled();
    });

    it('links a returning patient straight away when this clinician already treats them', async () => {
      supabaseAdmin.auth.admin.listUsers.mockResolvedValue({
        data: { users: [{ id: 'patient-9', email: 'Patient@Example.com' }] },
        error: null,
      });
      const chains = mockTables(supabaseAdmin, {
        profiles: [profileRow('clinician'), ok({ id: 'patient-9', role: 'patient' })],
        appointments: [ok([{ id: 'earlier-appt' }]), ok({ id: 'appt-7', status: 'active' })],
      });

      const response = await send('post', '/api/appointments').send(validPayload);

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ isReturningPatient: true, patientLinked: true });
      expect(chains.appointments[1].insert).toHaveBeenCalledWith(
        expect.objectContaining({ patient_id: 'patient-9', status: 'active' })
      );
    });

    it('should attach chosen and newly written questions to the appointment', async () => {
      const templateId = '11111111-1111-4111-8111-111111111111';
      const chains = mockTables(supabaseAdmin, {
        profiles: profileRow('clinician'),
        appointments: ok({ id: 'appt-123', status: 'invited' }),
        // The ownership check on the chosen ids, then the insert of new ones.
        questionnaire_templates: [ok([{ id: templateId }]), ok([{ id: 'new-template' }])],
        appointment_questionnaires: ok(null),
      });

      const response = await send('post', '/api/appointments').send({
        ...validPayload,
        questionnaireTemplateIds: [templateId],
        newQuestions: [
          { text: 'Any dizziness?', saveToList: false },
          { text: 'Which medicines are you taking?', responseType: 'text', saveToList: true },
        ],
      });

      expect(response.status).toBe(201);
      expect(chains.questionnaire_templates[0].eq).toHaveBeenCalledWith('clinician_id', mockUser.id);
      expect(chains.questionnaire_templates[1].insert).toHaveBeenCalledWith([
        { question_text: 'Any dizziness?', response_type: 'yes_no', clinician_id: mockUser.id, is_active: false },
        {
          question_text: 'Which medicines are you taking?',
          response_type: 'text',
          clinician_id: mockUser.id,
          is_active: true,
        },
      ]);
      expect(chains.appointment_questionnaires[0].insert).toHaveBeenCalledWith([
        { appointment_id: 'appt-123', template_id: templateId },
        { appointment_id: 'appt-123', template_id: 'new-template' },
      ]);
    });

    it("should reject questions from another clinician's library before creating anything", async () => {
      const chains = mockTables(supabaseAdmin, {
        profiles: profileRow('clinician'),
        questionnaire_templates: ok([]),
        appointments: ok({ id: 'never' }),
      });

      const response = await send('post', '/api/appointments').send({
        ...validPayload,
        questionnaireTemplateIds: ['22222222-2222-4222-8222-222222222222'],
      });

      expect(response.status).toBe(400);
      expect(chains.appointments).toBeUndefined();
      expect(createAndSendInvite).not.toHaveBeenCalled();
    });

    it('should return 403 if user is not a clinician', async () => {
      mockTables(supabaseAdmin, { profiles: profileRow('patient') });

      const response = await send('post', '/api/appointments').send(validPayload);

      expect(response.status).toBe(403);
    });

    it('should return 403 if the clinician is not verified yet', async () => {
      mockTables(supabaseAdmin, { profiles: profileRow('clinician', { verified: false }) });

      const response = await send('post', '/api/appointments').send(validPayload);

      expect(response.status).toBe(403);
      expect(response.body.error).toMatch(/pending verification/);
    });

    it('should return 400 for invalid payload', async () => {
      mockTables(supabaseAdmin, { profiles: profileRow('clinician') });

      const response = await send('post', '/api/appointments').send({ patientEmail: 'not-an-email' });

      expect(response.status).toBe(400);
    });
  });

  describe('GET /appointments', () => {
    it('should list appointments for the user', async () => {
      mockTables(supabaseAdmin, {
        profiles: profileRow('patient'),
        appointments: ok([{ id: 'appt-1' }]),
        appointment_invites: ok([]),
      });

      const response = await send('get', '/api/appointments');

      expect(response.status).toBe(200);
      // Appointments now carry the patient's name (or the invited name, for
      // one not yet accepted), so compare on identity rather than shape.
      expect(response.body).toHaveLength(1);
      expect(response.body[0]).toMatchObject({ id: 'appt-1' });
    });

    it('auto-claims pending invites matching the patient email upon listing', async () => {
      const chains = mockTables(supabaseAdmin, {
        profiles: profileRow('patient'),
        appointment_invites: [
          ok([{ id: 'invite-1', appointment_id: 'appt-99' }]),
          ok([]),
        ],
        appointments: [
          ok([{ id: 'appt-99', patient_id: mockUser.id }]),
          ok([{ id: 'appt-99', patient_id: mockUser.id }]),
        ],
      });

      const response = await send('get', '/api/appointments');

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(1);
      expect(response.body[0]).toMatchObject({ id: 'appt-99' });
      expect(chains.appointments[0].update).toHaveBeenCalledWith(
        expect.objectContaining({ patient_id: mockUser.id, status: 'active' })
      );
    });
  });

  describe('GET /appointments/:id', () => {
    it('should return appointment if user is owner', async () => {
      const mockAppointment = { id: 'appt-1', patient_id: mockUser.id, patient: { id: mockUser.id } };
      mockTables(supabaseAdmin, {
        profiles: profileRow('patient'),
        appointments: ok(mockAppointment),
        appointment_invites: ok([{ appointment_id: 'appt-1', patient_email: 'p@example.com' }]),
      });

      const response = await send('get', '/api/appointments/appt-1');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ...mockAppointment, invited_email: 'p@example.com' });
    });

    it('should return 403 if user is not owner', async () => {
      mockTables(supabaseAdmin, {
        profiles: profileRow('patient'),
        appointments: ok({ id: 'appt-1', patient_id: 'someone-else' }),
      });

      const response = await send('get', '/api/appointments/appt-1');

      expect(response.status).toBe(403);
    });

    it('should return 404 if not found', async () => {
      mockTables(supabaseAdmin, {
        profiles: profileRow('patient'),
        appointments: ok(null),
      });

      const response = await send('get', '/api/appointments/non-existent');

      expect(response.status).toBe(404);
    });
  });

  describe('PATCH /appointments/:id/status', () => {
    const ownAppointment = { id: 'appt-1', patient_id: 'patient-1', clinician_id: mockUser.id };

    it("should update the status of the clinician's own appointment", async () => {
      const mockUpdated = { id: 'appt-1', status: 'completed' };
      mockTables(supabaseAdmin, {
        profiles: profileRow('clinician'),
        // The access check, then the update.
        appointments: [ok(ownAppointment), ok(mockUpdated)],
      });

      const response = await send('patch', '/api/appointments/appt-1/status').send({ status: 'completed' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockUpdated);
    });

    it("should return 403 for another clinician's appointment", async () => {
      mockTables(supabaseAdmin, {
        profiles: profileRow('clinician'),
        appointments: ok({ ...ownAppointment, clinician_id: 'other-clinician' }),
      });

      const response = await send('patch', '/api/appointments/appt-1/status').send({ status: 'completed' });

      expect(response.status).toBe(403);
    });

    it('should let a patient check in to their own appointment', async () => {
      mockTables(supabaseAdmin, {
        profiles: profileRow('patient'),
        appointments: [ok({ ...ownAppointment, patient_id: mockUser.id }), ok({ id: 'appt-1', status: 'checked_in' })],
      });

      const response = await send('patch', '/api/appointments/appt-1/status').send({ status: 'checked_in' });

      expect(response.status).toBe(200);
    });

    it('does not alter report sharing automatically on check-in', async () => {
      const chains = mockTables(supabaseAdmin, {
        profiles: profileRow('patient'),
        appointments: [
          ok({ ...ownAppointment, patient_id: mockUser.id }),
          ok({ id: 'appt-1', patient_id: mockUser.id, status: 'checked_in' }),
        ],
      });

      const response = await send('patch', '/api/appointments/appt-1/status').send({ status: 'checked_in' });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('checked_in');
      expect(chains.appointment_lab_reports).toBeUndefined();
      expect(chains.lab_reports).toBeUndefined();
    });

    it('should not let a patient mark their appointment completed', async () => {
      mockTables(supabaseAdmin, {
        profiles: profileRow('patient'),
        appointments: ok({ ...ownAppointment, patient_id: mockUser.id }),
      });

      const response = await send('patch', '/api/appointments/appt-1/status').send({ status: 'completed' });

      expect(response.status).toBe(403);
    });
  });
});

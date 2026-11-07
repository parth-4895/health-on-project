const supabaseAdmin = require('../config/supabaseAdminClient');
const { createAndSendInvite } = require('../services/invite.service');
const { findAuthUserByEmail } = require('../services/authUsers.service');
const { assertAppointmentAccess, clinicianHasPatient } = require('../services/access.service');
const logger = require('../utils/logger');

/** A patient may only report that they have checked in; the rest is the clinic's call. */
const PATIENT_SETTABLE_STATUSES = new Set(['checked_in']);

/**
 * Creates an appointment and invites the patient to it.
 *
 * Linking a patient to an appointment is what gives the clinician access to
 * their records, so it needs the patient's consent. A patient this clinician
 * already treats is linked straight away. Anyone else, including a patient who
 * has an account but has never seen this clinician, stays `invited` until
 * they accept the emailed invite (returning patients confirm with their own
 * password).
 */
async function createAppointment(req, res, next) {
  try {
    const { patientEmail, patientFullName, scheduledAt, questionnaireTemplateIds = [], newQuestions = [] } = req.validated;
    const clinicianId = req.user.id;

    // Checked before anything is written, so a bad selection leaves no
    // half-created appointment behind.
    const templateIds = await ownTemplateIds(clinicianId, [...new Set(questionnaireTemplateIds)]);
    const existingPatientId = await findPatientIdByEmail(patientEmail);
    const alreadyTreating = existingPatientId
      ? await clinicianHasPatient(clinicianId, existingPatientId)
      : false;
    const linkedPatientId = existingPatientId || null;
    const appointmentStatus = linkedPatientId ? 'active' : 'invited';

    const { data: appointment, error } = await supabaseAdmin
      .from('appointments')
      .insert({
        clinician_id: clinicianId,
        patient_id: linkedPatientId,
        scheduled_at: scheduledAt,
        status: appointmentStatus,
      })
      .select()
      .single();

    if (error) throw error;

    await attachQuestionnaire({
      appointmentId: appointment.id,
      clinicianId,
      templateIds,
      newQuestions,
    });

    const invite = await createAndSendInvite({
      appointmentId: appointment.id,
      patientEmail,
      patientFullName,
    });

    res.status(201).json({
      ...appointment,
      isReturningPatient: Boolean(existingPatientId),
      // False until the patient accepts the invite, unless already treated here.
      patientLinked: Boolean(linkedPatientId),
      inviteLink: invite?.inviteLink ?? null,
      inviteEmailSent: invite?.emailSent === true,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Links the chosen questions to the appointment.
 *
 * Questions typed in for this visit become templates owned by the clinician.
 * Ones not saved to the library are stored inactive, so they are asked on
 * this appointment without cluttering the clinician's reusable list.
 */
async function attachQuestionnaire({ appointmentId, clinicianId, templateIds, newQuestions }) {
  const ids = [...templateIds];

  if (newQuestions.length > 0) {
    const { data: created, error } = await supabaseAdmin
      .from('questionnaire_templates')
      .insert(
        newQuestions.map((q) => ({
          question_text: q.text,
          response_type: q.responseType,
          clinician_id: clinicianId,
          is_active: q.saveToList,
        }))
      )
      .select('id');

    if (error) throw error;
    ids.push(...(created || []).map((t) => t.id));
  }

  if (ids.length === 0) return;

  const { error } = await supabaseAdmin
    .from('appointment_questionnaires')
    .insert(ids.map((templateId) => ({ appointment_id: appointmentId, template_id: templateId })));

  if (error) throw error;
}

/** The subset of `ids` that are questions from this clinician's own library. */
async function ownTemplateIds(clinicianId, ids) {
  if (ids.length === 0) return [];

  const { data, error } = await supabaseAdmin
    .from('questionnaire_templates')
    .select('id')
    .eq('clinician_id', clinicianId)
    .in('id', ids);

  if (error) throw error;

  const owned = new Set((data || []).map((t) => t.id));
  const foreign = ids.filter((id) => !owned.has(id));
  if (foreign.length > 0) {
    const err = new Error('Some selected questions are not in your library');
    err.status = 400;
    throw err;
  }
  return ids;
}

/** The profile id behind an email address, or null if nobody has signed up yet. */
async function findPatientIdByEmail(email) {
  const user = await findAuthUserByEmail(email);
  if (!user) return null;

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('id, role')
    .eq('id', user.id)
    .maybeSingle();

  return profile?.role === 'patient' ? profile.id : null;
}

async function listAppointments(req, res, next) {
  try {
    // If a patient is querying appointments, auto-claim any pending invites created for their verified email
    if (req.user.role === 'patient' && req.user.email) {
      try {
        const { data: pendingInvites } = await supabaseAdmin
          .from('appointment_invites')
          .select('id, appointment_id')
          .ilike('patient_email', req.user.email)
          .is('used_at', null);

        if (pendingInvites && pendingInvites.length > 0) {
          const apptIds = pendingInvites.map((i) => i.appointment_id);
          await supabaseAdmin
            .from('appointments')
            .update({ patient_id: req.user.id, status: 'active' })
            .in('id', apptIds)
            .is('patient_id', null);

          await supabaseAdmin
            .from('appointment_invites')
            .update({ used_at: new Date().toISOString() })
            .in('id', pendingInvites.map((i) => i.id));
        }
      } catch (claimErr) {
        logger.warn('Failed to auto-claim pending appointment invites for patient', {
          code: 'ERR_CLAIM_INVITES',
        });
      }
    }

    const column = req.user.role === 'clinician' ? 'clinician_id' : 'patient_id';

    const { data, error } = await supabaseAdmin
      .from('appointments')
      .select(
        '*, patient:profiles!appointments_patient_id_fkey ( id, full_name, phone ), clinician:profiles!appointments_clinician_id_fkey ( id, full_name )'
      )
      .eq(column, req.user.id)
      .order('scheduled_at', { ascending: true });

    if (error) throw error;

    // An invited patient who has not accepted yet has no profile row, so fall
    // back to the name the clinician typed on the invite.
    const withInviteNames = await attachInviteNames(data);

    res.json(withInviteNames);
  } catch (err) {
    next(err);
  }
}

/**
 * Adds the invited email to every appointment, and for one whose patient has
 * not accepted yet (no profile row) falls back to the name the clinician
 * typed on the invite.
 */
async function attachInviteNames(appointments) {
  if (appointments.length === 0) return appointments;

  const { data: invites } = await supabaseAdmin
    .from('appointment_invites')
    .select('appointment_id, patient_full_name, patient_email')
    .in('appointment_id', appointments.map((a) => a.id));

  const byAppointment = new Map((invites || []).map((i) => [i.appointment_id, i]));

  return appointments.map((appointment) => {
    const invite = byAppointment.get(appointment.id);
    const withEmail = { ...appointment, invited_email: invite?.patient_email ?? null };
    if (appointment.patient) return withEmail;

    return {
      ...withEmail,
      patient: invite?.patient_full_name
        ? { id: null, full_name: invite.patient_full_name, pending: true }
        : null,
    };
  });
}

async function getAppointment(req, res, next) {
  try {
    const { data, error } = await supabaseAdmin
      .from('appointments')
      .select(
        '*, patient:profiles!appointments_patient_id_fkey ( id, full_name, phone, patient_details ( * ) ), clinician:profiles!appointments_clinician_id_fkey ( id, full_name )'
      )
      .eq('id', req.params.id)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Appointment not found' });

    const isOwner = data.patient_id === req.user.id || data.clinician_id === req.user.id;
    if (!isOwner) return res.status(403).json({ error: 'Not authorized to view this appointment' });

    const [withInviteName] = await attachInviteNames([data]);
    res.json(withInviteName);
  } catch (err) {
    next(err);
  }
}

async function updateAppointmentStatus(req, res, next) {
  try {
    const { status } = req.validated;

    const access = await assertAppointmentAccess(req.params.id, req.user);
    if (!access.ok) return res.status(access.status).json({ error: access.error });

    if (req.user.role !== 'clinician' && !PATIENT_SETTABLE_STATUSES.has(status)) {
      return res.status(403).json({ error: `Patients cannot set an appointment to '${status}'` });
    }

    const { data, error } = await supabaseAdmin
      .from('appointments')
      .update({ status })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;

    res.json(data);
  } catch (err) {
    next(err);
  }
}

module.exports = { createAppointment, listAppointments, getAppointment, updateAppointmentStatus };

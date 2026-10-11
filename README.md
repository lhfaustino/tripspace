# Flight Menu

Flight Menu is a Next.js and Supabase application for managing crew rosters and flight meal-plan data.

## Getting Started

Install dependencies:

```bash
npm install
```

Start the development server:

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

## Main Workflows

- Upload user roster PDFs and show flight service data.
- Let the master/admin user upload the current meal-plan PDF.
- Replace old meal-plan records when a new meal plan is uploaded.
- Refresh saved roster flights against the current meal plan only when the meal plan has changed.
- Mark flights that are not found in the meal plan as `not found`.
- Save selected flights directly to the user's primary Google Calendar.

## Environment

The app uses Supabase for authentication, storage, and database records. Configure `.env.local` with the Supabase URL, anon key, service role key, and any webhook secrets used by the deployment.

### Google Calendar

The calendar action reuses the Google OAuth provider configured in Supabase. In the Google Cloud project used by that provider:

1. Enable the Google Calendar API.
2. Add `https://www.googleapis.com/auth/calendar.events` to the OAuth consent screen's data-access scopes.
3. Keep the app's `/auth/callback` URL in the Supabase redirect allow list.

Users grant calendar access only when they click **Google Agenda**. The app does not store Google access tokens in the database.

## Useful Commands

```bash
npm run dev
npm run build
npm run theme
```

## Project Structure

- `app/`: Next.js App Router pages, API routes, and server actions.
- `components/`: UI and feature components.
- `lib/`: shared application logic, PDF parsing, Supabase clients, and constants.
- `supabase/`: database migrations and local Supabase configuration.
- `docs/`: deployment and domain-specific project notes.

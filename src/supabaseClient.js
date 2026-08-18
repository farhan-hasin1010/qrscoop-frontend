import { createClient } from '@supabase/supabase-js';

// Get these from your Supabase Dashboard -> Project Settings -> API
const supabaseUrl = 'https://mnrjdwkxofyyharxoial.supabase.co';
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1ucmpkd2t4b2Z5eWhhcnhvaWFsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA0MTMyNTEsImV4cCI6MjA5NTk4OTI1MX0.VSNpi6ejhpnUCSZPV6lEuuI0XGMsOc4AfvKlT7W9EoI';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
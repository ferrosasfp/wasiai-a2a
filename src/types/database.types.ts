export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: '14.1';
  };
  public: {
    Tables: {
      a2a_agents: {
        Row: {
          agent_url: string;
          capabilities: Json;
          created_at: string;
          description: string;
          enabled: boolean;
          metadata: Json | null;
          name: string;
          owner_ref: string;
          payout_wallet: string | null;
          price_usdc: number;
          referrer_ref: string | null;
          slug: string;
        };
        Insert: {
          agent_url: string;
          capabilities: Json;
          created_at?: string;
          description?: string;
          enabled?: boolean;
          metadata?: Json | null;
          name: string;
          owner_ref: string;
          payout_wallet?: string | null;
          price_usdc?: number;
          referrer_ref?: string | null;
          slug: string;
        };
        Update: {
          agent_url?: string;
          capabilities?: Json;
          created_at?: string;
          description?: string;
          enabled?: boolean;
          metadata?: Json | null;
          name?: string;
          owner_ref?: string;
          payout_wallet?: string | null;
          price_usdc?: number;
          referrer_ref?: string | null;
          slug?: string;
        };
        Relationships: [];
      };
      a2a_arbitrations: {
        Row: {
          ambiguity_reason: string | null;
          at_stake_usd: number;
          created_at: string;
          decision: string;
          evidence_digest: string | null;
          id: string;
          intent_id: string;
          llm_reasoning: string | null;
          method: string;
          owner_ref: string;
          settle_usd: number;
          status: string;
        };
        Insert: {
          ambiguity_reason?: string | null;
          at_stake_usd: number;
          created_at?: string;
          decision: string;
          evidence_digest?: string | null;
          id?: string;
          intent_id: string;
          llm_reasoning?: string | null;
          method: string;
          owner_ref: string;
          settle_usd?: number;
          status: string;
        };
        Update: {
          ambiguity_reason?: string | null;
          at_stake_usd?: number;
          created_at?: string;
          decision?: string;
          evidence_digest?: string | null;
          id?: string;
          intent_id?: string;
          llm_reasoning?: string | null;
          method?: string;
          owner_ref?: string;
          settle_usd?: number;
          status?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'a2a_arbitrations_intent_id_fkey';
            columns: ['intent_id'];
            isOneToOne: false;
            referencedRelation: 'a2a_payment_intents';
            referencedColumns: ['id'];
          },
        ];
      };
      a2a_fee_splits: {
        Row: {
          amount_usdc: number;
          bps: number;
          created_at: string;
          error_message: string | null;
          id: string;
          orchestration_id: string;
          owner_ref: string;
          recipient_role: string;
          recipient_wallet: string;
          status: string;
          tx_hash: string | null;
          updated_at: string;
        };
        Insert: {
          amount_usdc: number;
          bps: number;
          created_at?: string;
          error_message?: string | null;
          id?: string;
          orchestration_id: string;
          owner_ref: string;
          recipient_role: string;
          recipient_wallet: string;
          status?: string;
          tx_hash?: string | null;
          updated_at?: string;
        };
        Update: {
          amount_usdc?: number;
          bps?: number;
          created_at?: string;
          error_message?: string | null;
          id?: string;
          orchestration_id?: string;
          owner_ref?: string;
          recipient_role?: string;
          recipient_wallet?: string;
          status?: string;
          tx_hash?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      a2a_agent_keys: {
        Row: {
          agentkit_wallet: Json | null;
          allowed_agent_slugs: string[] | null;
          allowed_categories: string[] | null;
          allowed_registries: string[] | null;
          budget: Json | null;
          created_at: string;
          daily_limit_usd: number | null;
          daily_reset_at: string | null;
          daily_spent_usd: number | null;
          display_name: string | null;
          erc8004_identity: Json | null;
          funding_wallet: string | null;
          id: string;
          is_active: boolean | null;
          key_hash: string;
          kite_passport: Json | null;
          last_used_at: string | null;
          max_spend_per_call_usd: number | null;
          metadata: Json | null;
          owner_ref: string;
          require_signature: boolean;
          updated_at: string;
        };
        Insert: {
          agentkit_wallet?: Json | null;
          allowed_agent_slugs?: string[] | null;
          allowed_categories?: string[] | null;
          allowed_registries?: string[] | null;
          budget?: Json | null;
          created_at?: string;
          daily_limit_usd?: number | null;
          daily_reset_at?: string | null;
          daily_spent_usd?: number | null;
          display_name?: string | null;
          erc8004_identity?: Json | null;
          funding_wallet?: string | null;
          id?: string;
          is_active?: boolean | null;
          key_hash: string;
          kite_passport?: Json | null;
          last_used_at?: string | null;
          max_spend_per_call_usd?: number | null;
          metadata?: Json | null;
          owner_ref: string;
          require_signature?: boolean;
          updated_at?: string;
        };
        Update: {
          agentkit_wallet?: Json | null;
          allowed_agent_slugs?: string[] | null;
          allowed_categories?: string[] | null;
          allowed_registries?: string[] | null;
          budget?: Json | null;
          created_at?: string;
          daily_limit_usd?: number | null;
          daily_reset_at?: string | null;
          daily_spent_usd?: number | null;
          display_name?: string | null;
          erc8004_identity?: Json | null;
          funding_wallet?: string | null;
          id?: string;
          is_active?: boolean | null;
          key_hash?: string;
          kite_passport?: Json | null;
          last_used_at?: string | null;
          max_spend_per_call_usd?: number | null;
          metadata?: Json | null;
          owner_ref?: string;
          require_signature?: boolean;
          updated_at?: string;
        };
        Relationships: [];
      };
      a2a_delegations: {
        Row: {
          created_at: string;
          expires_at: string;
          id: string;
          key_id: string;
          nonce: string;
          owner_ref: string;
          policy: Json;
          revoked_at: string | null;
          session_key_address: string;
          session_token_hash: string;
          total_spent: number;
          typed_data_raw: Json;
        };
        Insert: {
          created_at?: string;
          expires_at: string;
          id?: string;
          key_id: string;
          nonce: string;
          owner_ref: string;
          policy: Json;
          revoked_at?: string | null;
          session_key_address: string;
          session_token_hash: string;
          total_spent?: number;
          typed_data_raw: Json;
        };
        Update: {
          created_at?: string;
          expires_at?: string;
          id?: string;
          key_id?: string;
          nonce?: string;
          owner_ref?: string;
          policy?: Json;
          revoked_at?: string | null;
          session_key_address?: string;
          session_token_hash?: string;
          total_spent?: number;
          typed_data_raw?: Json;
        };
        Relationships: [
          {
            foreignKeyName: 'a2a_delegations_key_id_fkey';
            columns: ['key_id'];
            isOneToOne: false;
            referencedRelation: 'a2a_agent_keys';
            referencedColumns: ['id'];
          },
        ];
      };
      a2a_events: {
        Row: {
          agent_id: string | null;
          agent_name: string | null;
          cost_usdc: number | null;
          created_at: string;
          event_type: string;
          goal: string | null;
          id: string;
          latency_ms: number | null;
          metadata: Json | null;
          registry: string | null;
          status: string;
          tx_hash: string | null;
        };
        Insert: {
          agent_id?: string | null;
          agent_name?: string | null;
          cost_usdc?: number | null;
          created_at?: string;
          event_type?: string;
          goal?: string | null;
          id?: string;
          latency_ms?: number | null;
          metadata?: Json | null;
          registry?: string | null;
          status: string;
          tx_hash?: string | null;
        };
        Update: {
          agent_id?: string | null;
          agent_name?: string | null;
          cost_usdc?: number | null;
          created_at?: string;
          event_type?: string;
          goal?: string | null;
          id?: string;
          latency_ms?: number | null;
          metadata?: Json | null;
          registry?: string | null;
          status?: string;
          tx_hash?: string | null;
        };
        Relationships: [];
      };
      a2a_reputation_writebacks: {
        Row: {
          agent_slug: string;
          chain_id: number;
          created_at: string;
          error_code: string | null;
          event_id: string;
          id: string;
          onchain_agent_id: string;
          status: string;
          tx_hash: string | null;
          updated_at: string;
        };
        Insert: {
          agent_slug: string;
          chain_id: number;
          created_at?: string;
          error_code?: string | null;
          event_id: string;
          id?: string;
          onchain_agent_id: string;
          status: string;
          tx_hash?: string | null;
          updated_at?: string;
        };
        Update: {
          agent_slug?: string;
          chain_id?: number;
          created_at?: string;
          error_code?: string | null;
          event_id?: string;
          id?: string;
          onchain_agent_id?: string;
          status?: string;
          tx_hash?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      a2a_key_deposits: {
        Row: {
          amount_usd: number;
          chain_id: number;
          created_at: string;
          id: string;
          key_id: string;
          owner_ref: string;
          token: string | null;
          tx_hash: string;
        };
        Insert: {
          amount_usd: number;
          chain_id: number;
          created_at?: string;
          id?: string;
          key_id: string;
          owner_ref: string;
          token?: string | null;
          tx_hash: string;
        };
        Update: {
          amount_usd?: number;
          chain_id?: number;
          created_at?: string;
          id?: string;
          key_id?: string;
          owner_ref?: string;
          token?: string | null;
          tx_hash?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'a2a_key_deposits_key_id_fkey';
            columns: ['key_id'];
            isOneToOne: false;
            referencedRelation: 'a2a_agent_keys';
            referencedColumns: ['id'];
          },
        ];
      };
      a2a_key_dest_spend_ledger: {
        Row: {
          amount_usd: number;
          debited_at: string;
          destination: string;
          id: string;
          key_id: string;
          owner_ref: string;
        };
        Insert: {
          amount_usd: number;
          debited_at?: string;
          destination: string;
          id?: string;
          key_id: string;
          owner_ref: string;
        };
        Update: {
          amount_usd?: number;
          debited_at?: string;
          destination?: string;
          id?: string;
          key_id?: string;
          owner_ref?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'a2a_key_dest_spend_ledger_key_id_fkey';
            columns: ['key_id'];
            isOneToOne: false;
            referencedRelation: 'a2a_agent_keys';
            referencedColumns: ['id'];
          },
        ];
      };
      a2a_agent_links: {
        Row: {
          chain_id: number;
          consumed_cost_usdc: number | null;
          created_at: string;
          error_message: string | null;
          expires_at: string;
          id: string;
          key_id: string;
          max_price_usdc: number;
          owner_ref: string;
          redeemed_at: string | null;
          registry: string | null;
          settle_tx_hash: string | null;
          slug: string;
          status: string;
          token_hash: string;
          updated_at: string;
        };
        Insert: {
          chain_id: number;
          consumed_cost_usdc?: number | null;
          created_at?: string;
          error_message?: string | null;
          expires_at: string;
          id?: string;
          key_id: string;
          max_price_usdc: number;
          owner_ref: string;
          redeemed_at?: string | null;
          registry?: string | null;
          settle_tx_hash?: string | null;
          slug: string;
          status?: string;
          token_hash: string;
          updated_at?: string;
        };
        Update: {
          chain_id?: number;
          consumed_cost_usdc?: number | null;
          created_at?: string;
          error_message?: string | null;
          expires_at?: string;
          id?: string;
          key_id?: string;
          max_price_usdc?: number;
          owner_ref?: string;
          redeemed_at?: string | null;
          registry?: string | null;
          settle_tx_hash?: string | null;
          slug?: string;
          status?: string;
          token_hash?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'a2a_agent_links_key_id_fkey';
            columns: ['key_id'];
            isOneToOne: false;
            referencedRelation: 'a2a_agent_keys';
            referencedColumns: ['id'];
          },
        ];
      };
      a2a_inbound_tasks: {
        Row: {
          budget_usdc: number | null;
          constraints: Json;
          created_at: string;
          error_reason: string | null;
          external_ref: string | null;
          goal: string;
          id: string;
          orchestration_id: string | null;
          owner_ref: string;
          source: string;
          status: string;
          updated_at: string;
        };
        Insert: {
          budget_usdc?: number | null;
          constraints?: Json;
          created_at?: string;
          error_reason?: string | null;
          external_ref?: string | null;
          goal: string;
          id?: string;
          orchestration_id?: string | null;
          owner_ref: string;
          source: string;
          status?: string;
          updated_at?: string;
        };
        Update: {
          budget_usdc?: number | null;
          constraints?: Json;
          created_at?: string;
          error_reason?: string | null;
          external_ref?: string | null;
          goal?: string;
          id?: string;
          orchestration_id?: string | null;
          owner_ref?: string;
          source?: string;
          status?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      a2a_key_sessions: {
        Row: {
          allowed_agent_slugs: Json | null;
          allowed_categories: Json | null;
          allowed_registries: Json | null;
          created_at: string;
          derivation_mode: string;
          expires_at: string;
          id: string;
          key_id: string;
          max_budget_usd: number;
          owner_ref: string;
          require_signature: boolean;
          revoked_at: string | null;
          session_token_hash: string;
          signing_secret_hash: string | null;
          spent_usd: number;
          ttl_seconds: number;
        };
        Insert: {
          allowed_agent_slugs?: Json | null;
          allowed_categories?: Json | null;
          allowed_registries?: Json | null;
          created_at?: string;
          derivation_mode?: string;
          expires_at: string;
          id?: string;
          key_id: string;
          max_budget_usd: number;
          owner_ref: string;
          require_signature?: boolean;
          revoked_at?: string | null;
          session_token_hash: string;
          signing_secret_hash?: string | null;
          spent_usd?: number;
          ttl_seconds: number;
        };
        Update: {
          allowed_agent_slugs?: Json | null;
          allowed_categories?: Json | null;
          allowed_registries?: Json | null;
          created_at?: string;
          derivation_mode?: string;
          expires_at?: string;
          id?: string;
          key_id?: string;
          max_budget_usd?: number;
          owner_ref?: string;
          require_signature?: boolean;
          revoked_at?: string | null;
          session_token_hash?: string;
          signing_secret_hash?: string | null;
          spent_usd?: number;
          ttl_seconds?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'a2a_key_sessions_key_id_fkey';
            columns: ['key_id'];
            isOneToOne: false;
            referencedRelation: 'a2a_agent_keys';
            referencedColumns: ['id'];
          },
        ];
      };
      a2a_key_spend_policies: {
        Row: {
          created_at: string;
          destination: string;
          id: string;
          key_id: string;
          max_usd: number;
          owner_ref: string;
          updated_at: string;
          window_secs: number | null;
          window_type: string;
        };
        Insert: {
          created_at?: string;
          destination: string;
          id?: string;
          key_id: string;
          max_usd: number;
          owner_ref: string;
          updated_at?: string;
          window_secs?: number | null;
          window_type: string;
        };
        Update: {
          created_at?: string;
          destination?: string;
          id?: string;
          key_id?: string;
          max_usd?: number;
          owner_ref?: string;
          updated_at?: string;
          window_secs?: number | null;
          window_type?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'a2a_key_spend_policies_key_id_fkey';
            columns: ['key_id'];
            isOneToOne: false;
            referencedRelation: 'a2a_agent_keys';
            referencedColumns: ['id'];
          },
        ];
      };
      a2a_payment_intents: {
        Row: {
          authorized_usd: number;
          buyer_wallet: string | null;
          cap_nonce: string | null;
          cap_signature: string | null;
          chain_id: number;
          consumed_usd: number;
          created_at: string;
          error_message: string | null;
          expires_at: string;
          id: string;
          intent_type: string;
          key_id: string;
          owner_ref: string;
          pay_to: string;
          residual_usd: number | null;
          seller_ref: string;
          settle_outcome: string | null;
          settle_tx_hash: string | null;
          status: string;
          updated_at: string;
        };
        Insert: {
          authorized_usd: number;
          buyer_wallet?: string | null;
          cap_nonce?: string | null;
          cap_signature?: string | null;
          chain_id: number;
          consumed_usd?: number;
          created_at?: string;
          error_message?: string | null;
          expires_at: string;
          id?: string;
          intent_type: string;
          key_id: string;
          owner_ref: string;
          pay_to: string;
          residual_usd?: number | null;
          seller_ref: string;
          settle_outcome?: string | null;
          settle_tx_hash?: string | null;
          status?: string;
          updated_at?: string;
        };
        Update: {
          authorized_usd?: number;
          buyer_wallet?: string | null;
          cap_nonce?: string | null;
          cap_signature?: string | null;
          chain_id?: number;
          consumed_usd?: number;
          created_at?: string;
          error_message?: string | null;
          expires_at?: string;
          id?: string;
          intent_type?: string;
          key_id?: string;
          owner_ref?: string;
          pay_to?: string;
          residual_usd?: number | null;
          seller_ref?: string;
          settle_outcome?: string | null;
          settle_tx_hash?: string | null;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'a2a_payment_intents_key_id_fkey';
            columns: ['key_id'];
            isOneToOne: false;
            referencedRelation: 'a2a_agent_keys';
            referencedColumns: ['id'];
          },
        ];
      };
      a2a_payment_intent_debit_signatures: {
        Row: {
          captured_at: string;
          created_at: string;
          // NUMERIC(78,0) uint256 → string (evita pérdida de precisión > 2^53).
          debit_amount_atomic: string;
          debit_deadline: number;
          debit_hop1_confirmed_at: string | null;
          debit_hop1_tx_hash: string | null;
          debit_key_id_hash: string;
          // NUMERIC(78,0) uint256 → string (evita pérdida de precisión > 2^53).
          debit_nonce: string;
          debit_settle_status: string | null;
          debit_signature: string;
          debit_signer_recovered: string | null;
          debit_validation_reason: string | null;
          debit_validation_status: string;
          id: string;
          intent_id: string;
          key_id: string;
          owner_ref: string;
        };
        Insert: {
          captured_at?: string;
          created_at?: string;
          // NUMERIC(78,0) uint256 → string (evita pérdida de precisión > 2^53).
          debit_amount_atomic: string;
          debit_deadline: number;
          debit_hop1_confirmed_at?: string | null;
          debit_hop1_tx_hash?: string | null;
          debit_key_id_hash: string;
          // NUMERIC(78,0) uint256 → string (evita pérdida de precisión > 2^53).
          debit_nonce: string;
          debit_settle_status?: string | null;
          debit_signature: string;
          debit_signer_recovered?: string | null;
          debit_validation_reason?: string | null;
          debit_validation_status: string;
          id?: string;
          intent_id: string;
          key_id: string;
          owner_ref: string;
        };
        Update: {
          captured_at?: string;
          created_at?: string;
          // NUMERIC(78,0) uint256 → string (evita pérdida de precisión > 2^53).
          debit_amount_atomic?: string;
          debit_deadline?: number;
          debit_hop1_confirmed_at?: string | null;
          debit_hop1_tx_hash?: string | null;
          debit_key_id_hash?: string;
          // NUMERIC(78,0) uint256 → string (evita pérdida de precisión > 2^53).
          debit_nonce?: string;
          debit_settle_status?: string | null;
          debit_signature?: string;
          debit_signer_recovered?: string | null;
          debit_validation_reason?: string | null;
          debit_validation_status?: string;
          id?: string;
          intent_id?: string;
          key_id?: string;
          owner_ref?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'a2a_payment_intent_debit_signatures_intent_id_fkey';
            columns: ['intent_id'];
            isOneToOne: false;
            referencedRelation: 'a2a_payment_intents';
            referencedColumns: ['id'];
          },
        ];
      };
      a2a_payment_vouchers: {
        Row: {
          amount_usd: number;
          created_at: string;
          id: string;
          intent_id: string;
          owner_ref: string;
          voucher_id: string;
          voucher_signature: string | null;
        };
        Insert: {
          amount_usd: number;
          created_at?: string;
          id?: string;
          intent_id: string;
          owner_ref: string;
          voucher_id: string;
          voucher_signature?: string | null;
        };
        Update: {
          amount_usd?: number;
          created_at?: string;
          id?: string;
          intent_id?: string;
          owner_ref?: string;
          voucher_id?: string;
          voucher_signature?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'a2a_payment_vouchers_intent_id_fkey';
            columns: ['intent_id'];
            isOneToOne: false;
            referencedRelation: 'a2a_payment_intents';
            referencedColumns: ['id'];
          },
        ];
      };
      a2a_protocol_fees: {
        Row: {
          budget_usdc: number;
          created_at: string;
          error_message: string | null;
          fee_rate: number;
          fee_total_usdc: number | null;
          fee_usdc: number;
          fee_wallet: string;
          orchestration_id: string;
          status: string;
          tx_hash: string | null;
          updated_at: string;
        };
        Insert: {
          budget_usdc: number;
          created_at?: string;
          error_message?: string | null;
          fee_rate: number;
          fee_total_usdc?: number | null;
          fee_usdc: number;
          fee_wallet: string;
          orchestration_id: string;
          status: string;
          tx_hash?: string | null;
          updated_at?: string;
        };
        Update: {
          budget_usdc?: number;
          created_at?: string;
          error_message?: string | null;
          fee_rate?: number;
          fee_total_usdc?: number | null;
          fee_usdc?: number;
          fee_wallet?: string;
          orchestration_id?: string;
          status?: string;
          tx_hash?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      a2a_receipts: {
        Row: {
          agent_key_id: string | null;
          amount_usd: number;
          chain_id: number;
          counterparty: string | null;
          created_at: string;
          delegation_id: string | null;
          id: string;
          orchestration_id: string | null;
          owner_ref: string;
          prev_receipt_hash: string | null;
          receipt_hash: string;
          receipt_type: string;
          session_id: string | null;
          tx_hash: string | null;
        };
        Insert: {
          agent_key_id?: string | null;
          amount_usd: number;
          chain_id: number;
          counterparty?: string | null;
          created_at?: string;
          delegation_id?: string | null;
          id?: string;
          orchestration_id?: string | null;
          owner_ref: string;
          prev_receipt_hash?: string | null;
          receipt_hash?: string;
          receipt_type: string;
          session_id?: string | null;
          tx_hash?: string | null;
        };
        Update: {
          agent_key_id?: string | null;
          amount_usd?: number;
          chain_id?: number;
          counterparty?: string | null;
          created_at?: string;
          delegation_id?: string | null;
          id?: string;
          orchestration_id?: string | null;
          owner_ref?: string;
          prev_receipt_hash?: string | null;
          receipt_hash?: string;
          receipt_type?: string;
          session_id?: string | null;
          tx_hash?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'a2a_receipts_agent_key_id_fkey';
            columns: ['agent_key_id'];
            isOneToOne: false;
            referencedRelation: 'a2a_agent_keys';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'a2a_receipts_delegation_id_fkey';
            columns: ['delegation_id'];
            isOneToOne: false;
            referencedRelation: 'a2a_delegations';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'a2a_receipts_session_id_fkey';
            columns: ['session_id'];
            isOneToOne: false;
            referencedRelation: 'a2a_key_sessions';
            referencedColumns: ['id'];
          },
        ];
      };
      a2a_refund_outbox: {
        Row: {
          amount_usd: number;
          attempts: number;
          chain_id: number;
          created_at: string;
          destination: string | null;
          id: string;
          key_id: string;
          last_error: string | null;
          owner_ref: string;
          reason: string;
          status: string;
          updated_at: string;
        };
        Insert: {
          amount_usd: number;
          attempts?: number;
          chain_id: number;
          created_at?: string;
          destination?: string | null;
          id?: string;
          key_id: string;
          last_error?: string | null;
          owner_ref: string;
          reason: string;
          status?: string;
          updated_at?: string;
        };
        Update: {
          amount_usd?: number;
          attempts?: number;
          chain_id?: number;
          created_at?: string;
          destination?: string | null;
          id?: string;
          key_id?: string;
          last_error?: string | null;
          owner_ref?: string;
          reason?: string;
          status?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      a2a_signed_auth_nonces: {
        Row: {
          created_at: string;
          expires_at: string;
          nonce: string;
          token_hash: string;
        };
        Insert: {
          created_at?: string;
          expires_at: string;
          nonce: string;
          token_hash: string;
        };
        Update: {
          created_at?: string;
          expires_at?: string;
          nonce?: string;
          token_hash?: string;
        };
        Relationships: [];
      };
      a2a_x402_nonces: {
        Row: {
          created_at: string;
          network: string;
          nonce: string;
        };
        Insert: {
          created_at?: string;
          network: string;
          nonce: string;
        };
        Update: {
          created_at?: string;
          network?: string;
          nonce?: string;
        };
        Relationships: [];
      };
      agent_calls: {
        Row: {
          agent_id: string | null;
          agent_slug: string | null;
          amount_paid: number;
          called_at: string | null;
          called_by_agent: string | null;
          caller_agent_id: string | null;
          caller_id: string | null;
          caller_type: string;
          caller_wallet: string | null;
          id: string;
          is_trial: boolean;
          key_id: string | null;
          latency_ms: number | null;
          nonce: string | null;
          on_chain_recorded: boolean | null;
          on_chain_tx_hash: string | null;
          payment_type: string;
          pipeline_id: string | null;
          receipt_signature: string | null;
          result_type: string | null;
          settled_at: string | null;
          settlement_batch_id: string | null;
          settlement_tx_hash: string | null;
          status: string;
          step_index: number | null;
          tx_hash: string | null;
        };
        Insert: {
          agent_id?: string | null;
          agent_slug?: string | null;
          amount_paid: number;
          called_at?: string | null;
          called_by_agent?: string | null;
          caller_agent_id?: string | null;
          caller_id?: string | null;
          caller_type?: string;
          caller_wallet?: string | null;
          id?: string;
          is_trial?: boolean;
          key_id?: string | null;
          latency_ms?: number | null;
          nonce?: string | null;
          on_chain_recorded?: boolean | null;
          on_chain_tx_hash?: string | null;
          payment_type?: string;
          pipeline_id?: string | null;
          receipt_signature?: string | null;
          result_type?: string | null;
          settled_at?: string | null;
          settlement_batch_id?: string | null;
          settlement_tx_hash?: string | null;
          status?: string;
          step_index?: number | null;
          tx_hash?: string | null;
        };
        Update: {
          agent_id?: string | null;
          agent_slug?: string | null;
          amount_paid?: number;
          called_at?: string | null;
          called_by_agent?: string | null;
          caller_agent_id?: string | null;
          caller_id?: string | null;
          caller_type?: string;
          caller_wallet?: string | null;
          id?: string;
          is_trial?: boolean;
          key_id?: string | null;
          latency_ms?: number | null;
          nonce?: string | null;
          on_chain_recorded?: boolean | null;
          on_chain_tx_hash?: string | null;
          payment_type?: string;
          pipeline_id?: string | null;
          receipt_signature?: string | null;
          result_type?: string | null;
          settled_at?: string | null;
          settlement_batch_id?: string | null;
          settlement_tx_hash?: string | null;
          status?: string;
          step_index?: number | null;
          tx_hash?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'agent_calls_key_id_fkey';
            columns: ['key_id'];
            isOneToOne: false;
            referencedRelation: 'agent_keys';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'agent_calls_pipeline_id_fkey';
            columns: ['pipeline_id'];
            isOneToOne: false;
            referencedRelation: 'pipeline_executions';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'model_calls_model_id_fkey';
            columns: ['agent_id'];
            isOneToOne: false;
            referencedRelation: 'agents';
            referencedColumns: ['id'];
          },
        ];
      };
      agent_categories: {
        Row: {
          created_at: string;
          is_active: boolean;
          label: string;
          slug: string;
        };
        Insert: {
          created_at?: string;
          is_active?: boolean;
          label: string;
          slug: string;
        };
        Update: {
          created_at?: string;
          is_active?: boolean;
          label?: string;
          slug?: string;
        };
        Relationships: [];
      };
      agent_examples: {
        Row: {
          agent_id: string;
          created_at: string;
          creator_id: string;
          id: string;
          input: string;
          label: string | null;
          output: string;
          sort_order: number;
          updated_at: string;
        };
        Insert: {
          agent_id: string;
          created_at?: string;
          creator_id: string;
          id?: string;
          input: string;
          label?: string | null;
          output: string;
          sort_order?: number;
          updated_at?: string;
        };
        Update: {
          agent_id?: string;
          created_at?: string;
          creator_id?: string;
          id?: string;
          input?: string;
          label?: string | null;
          output?: string;
          sort_order?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'agent_examples_agent_id_fkey';
            columns: ['agent_id'];
            isOneToOne: false;
            referencedRelation: 'agents';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'agent_examples_creator_id_fkey';
            columns: ['creator_id'];
            isOneToOne: false;
            referencedRelation: 'creator_pending_earnings';
            referencedColumns: ['creator_id'];
          },
          {
            foreignKeyName: 'agent_examples_creator_id_fkey';
            columns: ['creator_id'];
            isOneToOne: false;
            referencedRelation: 'creator_profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      agent_identities: {
        Row: {
          chain: string;
          chain_address: string;
          chain_id: number;
          created_at: string | null;
          display_name: string | null;
          framework: string | null;
          id: string;
          max_spend_per_call: number | null;
          owner_id: string | null;
          permissions: Json | null;
          total_calls: number | null;
          total_spent: number | null;
          updated_at: string | null;
          verified: boolean | null;
          verified_at: string | null;
        };
        Insert: {
          chain?: string;
          chain_address: string;
          chain_id?: number;
          created_at?: string | null;
          display_name?: string | null;
          framework?: string | null;
          id?: string;
          max_spend_per_call?: number | null;
          owner_id?: string | null;
          permissions?: Json | null;
          total_calls?: number | null;
          total_spent?: number | null;
          updated_at?: string | null;
          verified?: boolean | null;
          verified_at?: string | null;
        };
        Update: {
          chain?: string;
          chain_address?: string;
          chain_id?: number;
          created_at?: string | null;
          display_name?: string | null;
          framework?: string | null;
          id?: string;
          max_spend_per_call?: number | null;
          owner_id?: string | null;
          permissions?: Json | null;
          total_calls?: number | null;
          total_spent?: number | null;
          updated_at?: string | null;
          verified?: boolean | null;
          verified_at?: string | null;
        };
        Relationships: [];
      };
      agent_keys: {
        Row: {
          agentkit_wallet: string | null;
          allowed_categories: string[] | null;
          allowed_slugs: string[] | null;
          balance_synced_at: string | null;
          budget_usdc: number | null;
          created_at: string | null;
          daily_limit_usdc: number | null;
          daily_reset_at: string | null;
          daily_spent_usdc: number | null;
          erc8004_identity: string | null;
          erc8004_verified: boolean | null;
          id: string;
          is_active: boolean | null;
          key_hash: string;
          last_used_at: string | null;
          name: string;
          owner_id: string | null;
          owner_wallet_address: string | null;
          spent_usdc: number | null;
        };
        Insert: {
          agentkit_wallet?: string | null;
          allowed_categories?: string[] | null;
          allowed_slugs?: string[] | null;
          balance_synced_at?: string | null;
          budget_usdc?: number | null;
          created_at?: string | null;
          daily_limit_usdc?: number | null;
          daily_reset_at?: string | null;
          daily_spent_usdc?: number | null;
          erc8004_identity?: string | null;
          erc8004_verified?: boolean | null;
          id?: string;
          is_active?: boolean | null;
          key_hash: string;
          last_used_at?: string | null;
          name: string;
          owner_id?: string | null;
          owner_wallet_address?: string | null;
          spent_usdc?: number | null;
        };
        Update: {
          agentkit_wallet?: string | null;
          allowed_categories?: string[] | null;
          allowed_slugs?: string[] | null;
          balance_synced_at?: string | null;
          budget_usdc?: number | null;
          created_at?: string | null;
          daily_limit_usdc?: number | null;
          daily_reset_at?: string | null;
          daily_spent_usdc?: number | null;
          erc8004_identity?: string | null;
          erc8004_verified?: boolean | null;
          id?: string;
          is_active?: boolean | null;
          key_hash?: string;
          last_used_at?: string | null;
          name?: string;
          owner_id?: string | null;
          owner_wallet_address?: string | null;
          spent_usdc?: number | null;
        };
        Relationships: [];
      };
      agent_ratings: {
        Row: {
          agent_id: string;
          created_at: string | null;
          id: string;
          rating: number;
          updated_at: string | null;
          voter_id: string;
        };
        Insert: {
          agent_id: string;
          created_at?: string | null;
          id?: string;
          rating: number;
          updated_at?: string | null;
          voter_id: string;
        };
        Update: {
          agent_id?: string;
          created_at?: string | null;
          id?: string;
          rating?: number;
          updated_at?: string | null;
          voter_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'agent_ratings_agent_id_fkey';
            columns: ['agent_id'];
            isOneToOne: false;
            referencedRelation: 'agents';
            referencedColumns: ['id'];
          },
        ];
      };
      agent_trials: {
        Row: {
          agent_id: string;
          id: string;
          times_used: number;
          used_at: string;
          user_id: string;
        };
        Insert: {
          agent_id: string;
          id?: string;
          times_used?: number;
          used_at?: string;
          user_id: string;
        };
        Update: {
          agent_id?: string;
          id?: string;
          times_used?: number;
          used_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'agent_trials_agent_id_fkey';
            columns: ['agent_id'];
            isOneToOne: false;
            referencedRelation: 'agents';
            referencedColumns: ['id'];
          },
        ];
      };
      agent_wallets: {
        Row: {
          agent_id: string;
          created_at: string;
          encrypted_private_key: string;
          updated_at: string;
          wallet_address: string;
        };
        Insert: {
          agent_id: string;
          created_at?: string;
          encrypted_private_key: string;
          updated_at?: string;
          wallet_address: string;
        };
        Update: {
          agent_id?: string;
          created_at?: string;
          encrypted_private_key?: string;
          updated_at?: string;
          wallet_address?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'agent_wallets_agent_id_fkey';
            columns: ['agent_id'];
            isOneToOne: true;
            referencedRelation: 'agents';
            referencedColumns: ['id'];
          },
        ];
      };
      agents: {
        Row: {
          agent_type: string;
          capabilities: Json | null;
          category: string;
          chain: string;
          chain_registered_at: string | null;
          consecutive_failures: number;
          cover_image: string | null;
          created_at: string | null;
          creator_id: string | null;
          creator_price: number | null;
          creator_wallet: string | null;
          currency: string;
          dependencies: string[] | null;
          description: string | null;
          endpoint_url: string | null;
          erc8004_id: number | null;
          free_trial_enabled: boolean;
          free_trial_limit: number;
          health_check: Json | null;
          id: string;
          input_schema: Json | null;
          is_featured: boolean | null;
          is_verified: boolean;
          last_checked_at: string | null;
          long_running: boolean;
          marketplace_address: string | null;
          max_rpd: number;
          max_rpm: number;
          mcp_description: string | null;
          mcp_tool_name: string | null;
          metadata: Json | null;
          name: string;
          on_chain_registered: boolean | null;
          output_schema: Json | null;
          performance_score: number | null;
          price_per_call: number;
          registration_type:
            | Database['public']['Enums']['registration_type']
            | null;
          reputation_count: number | null;
          reputation_score: number | null;
          sandbox_enabled: boolean;
          search_vector: unknown;
          slug: string;
          status: string;
          tags: string[] | null;
          token_id: number | null;
          total_calls: number | null;
          total_revenue: number | null;
          updated_at: string | null;
          webhook_secret: string;
        };
        Insert: {
          agent_type?: string;
          capabilities?: Json | null;
          category: string;
          chain?: string;
          chain_registered_at?: string | null;
          consecutive_failures?: number;
          cover_image?: string | null;
          created_at?: string | null;
          creator_id?: string | null;
          creator_price?: number | null;
          creator_wallet?: string | null;
          currency?: string;
          dependencies?: string[] | null;
          description?: string | null;
          endpoint_url?: string | null;
          erc8004_id?: number | null;
          free_trial_enabled?: boolean;
          free_trial_limit?: number;
          health_check?: Json | null;
          id?: string;
          input_schema?: Json | null;
          is_featured?: boolean | null;
          is_verified?: boolean;
          last_checked_at?: string | null;
          long_running?: boolean;
          marketplace_address?: string | null;
          max_rpd?: number;
          max_rpm?: number;
          mcp_description?: string | null;
          mcp_tool_name?: string | null;
          metadata?: Json | null;
          name: string;
          on_chain_registered?: boolean | null;
          output_schema?: Json | null;
          performance_score?: number | null;
          price_per_call?: number;
          registration_type?:
            | Database['public']['Enums']['registration_type']
            | null;
          reputation_count?: number | null;
          reputation_score?: number | null;
          sandbox_enabled?: boolean;
          search_vector?: unknown;
          slug: string;
          status?: string;
          tags?: string[] | null;
          token_id?: number | null;
          total_calls?: number | null;
          total_revenue?: number | null;
          updated_at?: string | null;
          webhook_secret: string;
        };
        Update: {
          agent_type?: string;
          capabilities?: Json | null;
          category?: string;
          chain?: string;
          chain_registered_at?: string | null;
          consecutive_failures?: number;
          cover_image?: string | null;
          created_at?: string | null;
          creator_id?: string | null;
          creator_price?: number | null;
          creator_wallet?: string | null;
          currency?: string;
          dependencies?: string[] | null;
          description?: string | null;
          endpoint_url?: string | null;
          erc8004_id?: number | null;
          free_trial_enabled?: boolean;
          free_trial_limit?: number;
          health_check?: Json | null;
          id?: string;
          input_schema?: Json | null;
          is_featured?: boolean | null;
          is_verified?: boolean;
          last_checked_at?: string | null;
          long_running?: boolean;
          marketplace_address?: string | null;
          max_rpd?: number;
          max_rpm?: number;
          mcp_description?: string | null;
          mcp_tool_name?: string | null;
          metadata?: Json | null;
          name?: string;
          on_chain_registered?: boolean | null;
          output_schema?: Json | null;
          performance_score?: number | null;
          price_per_call?: number;
          registration_type?:
            | Database['public']['Enums']['registration_type']
            | null;
          reputation_count?: number | null;
          reputation_score?: number | null;
          sandbox_enabled?: boolean;
          search_vector?: unknown;
          slug?: string;
          status?: string;
          tags?: string[] | null;
          token_id?: number | null;
          total_calls?: number | null;
          total_revenue?: number | null;
          updated_at?: string | null;
          webhook_secret?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'agents_creator_id_creator_profiles_fk';
            columns: ['creator_id'];
            isOneToOne: false;
            referencedRelation: 'creator_pending_earnings';
            referencedColumns: ['creator_id'];
          },
          {
            foreignKeyName: 'agents_creator_id_creator_profiles_fk';
            columns: ['creator_id'];
            isOneToOne: false;
            referencedRelation: 'creator_profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      app_settings: {
        Row: {
          created_at: string;
          description: string | null;
          key: string;
          updated_at: string;
          value: string;
        };
        Insert: {
          created_at?: string;
          description?: string | null;
          key: string;
          updated_at?: string;
          value: string;
        };
        Update: {
          created_at?: string;
          description?: string | null;
          key?: string;
          updated_at?: string;
          value?: string;
        };
        Relationships: [];
      };
      chainlink_price_cache: {
        Row: {
          feed_address: string;
          payload: Json;
          token_symbol: string;
          updated_at: string;
        };
        Insert: {
          feed_address: string;
          payload: Json;
          token_symbol: string;
          updated_at?: string;
        };
        Update: {
          feed_address?: string;
          payload?: Json;
          token_symbol?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      collection_agents: {
        Row: {
          agent_id: string;
          collection_id: string;
          sort_order: number | null;
        };
        Insert: {
          agent_id: string;
          collection_id: string;
          sort_order?: number | null;
        };
        Update: {
          agent_id?: string;
          collection_id?: string;
          sort_order?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: 'collection_agents_agent_id_fkey';
            columns: ['agent_id'];
            isOneToOne: false;
            referencedRelation: 'agents';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'collection_agents_collection_id_fkey';
            columns: ['collection_id'];
            isOneToOne: false;
            referencedRelation: 'collections';
            referencedColumns: ['id'];
          },
        ];
      };
      collections: {
        Row: {
          cover_image: string | null;
          created_at: string | null;
          description: string | null;
          featured: boolean | null;
          id: string;
          name: string;
          slug: string;
          sort_order: number | null;
        };
        Insert: {
          cover_image?: string | null;
          created_at?: string | null;
          description?: string | null;
          featured?: boolean | null;
          id?: string;
          name: string;
          slug: string;
          sort_order?: number | null;
        };
        Update: {
          cover_image?: string | null;
          created_at?: string | null;
          description?: string | null;
          featured?: boolean | null;
          id?: string;
          name?: string;
          slug?: string;
          sort_order?: number | null;
        };
        Relationships: [];
      };
      creator_profiles: {
        Row: {
          account_status: Database['public']['Enums']['account_status_enum'];
          avatar_url: string | null;
          bio: string | null;
          created_at: string | null;
          display_name: string | null;
          email_domain: string | null;
          id: string;
          onboarding_completed: boolean;
          onboarding_step: number;
          pending_earnings_usdc: number;
          total_earnings: number | null;
          total_models: number | null;
          username: string;
          verified: boolean | null;
          wallet_address: string | null;
        };
        Insert: {
          account_status?: Database['public']['Enums']['account_status_enum'];
          avatar_url?: string | null;
          bio?: string | null;
          created_at?: string | null;
          display_name?: string | null;
          email_domain?: string | null;
          id: string;
          onboarding_completed?: boolean;
          onboarding_step?: number;
          pending_earnings_usdc?: number;
          total_earnings?: number | null;
          total_models?: number | null;
          username: string;
          verified?: boolean | null;
          wallet_address?: string | null;
        };
        Update: {
          account_status?: Database['public']['Enums']['account_status_enum'];
          avatar_url?: string | null;
          bio?: string | null;
          created_at?: string | null;
          display_name?: string | null;
          email_domain?: string | null;
          id?: string;
          onboarding_completed?: boolean;
          onboarding_step?: number;
          pending_earnings_usdc?: number;
          total_earnings?: number | null;
          total_models?: number | null;
          username?: string;
          verified?: boolean | null;
          wallet_address?: string | null;
        };
        Relationships: [];
      };
      creator_withdrawal_vouchers: {
        Row: {
          claimed_at: string | null;
          created_at: string;
          creator_id: string;
          deadline: number;
          gross_amount_usdc: number;
          id: string;
          nonce: string;
          status: string;
          tx_hash: string | null;
          wallet_address: string;
        };
        Insert: {
          claimed_at?: string | null;
          created_at?: string;
          creator_id: string;
          deadline: number;
          gross_amount_usdc: number;
          id?: string;
          nonce: string;
          status?: string;
          tx_hash?: string | null;
          wallet_address: string;
        };
        Update: {
          claimed_at?: string | null;
          created_at?: string;
          creator_id?: string;
          deadline?: number;
          gross_amount_usdc?: number;
          id?: string;
          nonce?: string;
          status?: string;
          tx_hash?: string | null;
          wallet_address?: string;
        };
        Relationships: [];
      };
      creator_withdrawals: {
        Row: {
          amount_usdc: number;
          created_at: string;
          creator_id: string;
          id: string;
          tx_hash: string;
        };
        Insert: {
          amount_usdc: number;
          created_at?: string;
          creator_id: string;
          id?: string;
          tx_hash: string;
        };
        Update: {
          amount_usdc?: number;
          created_at?: string;
          creator_id?: string;
          id?: string;
          tx_hash?: string;
        };
        Relationships: [];
      };
      disputes: {
        Row: {
          agent_id: string;
          call_id: string;
          caller_key_id: string;
          created_at: string | null;
          description: string | null;
          id: string;
          reason: string;
          resolution_note: string | null;
          resolved_at: string | null;
          status: string;
        };
        Insert: {
          agent_id: string;
          call_id: string;
          caller_key_id: string;
          created_at?: string | null;
          description?: string | null;
          id?: string;
          reason: string;
          resolution_note?: string | null;
          resolved_at?: string | null;
          status?: string;
        };
        Update: {
          agent_id?: string;
          call_id?: string;
          caller_key_id?: string;
          created_at?: string | null;
          description?: string | null;
          id?: string;
          reason?: string;
          resolution_note?: string | null;
          resolved_at?: string | null;
          status?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'disputes_agent_id_fkey';
            columns: ['agent_id'];
            isOneToOne: false;
            referencedRelation: 'agents';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'disputes_call_id_fkey';
            columns: ['call_id'];
            isOneToOne: false;
            referencedRelation: 'agent_calls';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'disputes_caller_key_id_fkey';
            columns: ['caller_key_id'];
            isOneToOne: false;
            referencedRelation: 'agent_keys';
            referencedColumns: ['id'];
          },
        ];
      };
      escrow_transactions: {
        Row: {
          agent_slug: string;
          amount_usdc: number;
          created_at: string;
          escrow_id: string;
          id: string;
          payer_address: string;
          payer_user_id: string | null;
          refunded_at: string | null;
          released_at: string | null;
          result_data: Json | null;
          status: string;
          tx_create: string | null;
          tx_release: string | null;
        };
        Insert: {
          agent_slug: string;
          amount_usdc: number;
          created_at?: string;
          escrow_id: string;
          id?: string;
          payer_address: string;
          payer_user_id?: string | null;
          refunded_at?: string | null;
          released_at?: string | null;
          result_data?: Json | null;
          status?: string;
          tx_create?: string | null;
          tx_release?: string | null;
        };
        Update: {
          agent_slug?: string;
          amount_usdc?: number;
          created_at?: string;
          escrow_id?: string;
          id?: string;
          payer_address?: string;
          payer_user_id?: string | null;
          refunded_at?: string | null;
          released_at?: string | null;
          result_data?: Json | null;
          status?: string;
          tx_create?: string | null;
          tx_release?: string | null;
        };
        Relationships: [];
      };
      facilitator_audit_log: {
        Row: {
          duration_ms: number;
          error_code: string | null;
          id: string;
          idempotency_key: string | null;
          ip: string | null;
          method: string;
          path: string;
          request_id: string;
          status_code: number;
          timestamp: string;
          user_agent: string | null;
        };
        Insert: {
          duration_ms: number;
          error_code?: string | null;
          id?: string;
          idempotency_key?: string | null;
          ip?: string | null;
          method: string;
          path: string;
          request_id: string;
          status_code: number;
          timestamp?: string;
          user_agent?: string | null;
        };
        Update: {
          duration_ms?: number;
          error_code?: string | null;
          id?: string;
          idempotency_key?: string | null;
          ip?: string | null;
          method?: string;
          path?: string;
          request_id?: string;
          status_code?: number;
          timestamp?: string;
          user_agent?: string | null;
        };
        Relationships: [];
      };
      facilitator_settlements: {
        Row: {
          amount: number;
          asset: string;
          block_number: number | null;
          created_at: string;
          duration_ms: number;
          error_code: string | null;
          error_http: number | null;
          id: string;
          idempotency_key: string;
          method: string;
          network: string;
          payee: string;
          payer: string;
          status: string;
          tx_hash: string | null;
        };
        Insert: {
          amount: number;
          asset: string;
          block_number?: number | null;
          created_at?: string;
          duration_ms: number;
          error_code?: string | null;
          error_http?: number | null;
          id?: string;
          idempotency_key: string;
          method: string;
          network: string;
          payee: string;
          payer: string;
          status: string;
          tx_hash?: string | null;
        };
        Update: {
          amount?: number;
          asset?: string;
          block_number?: number | null;
          created_at?: string;
          duration_ms?: number;
          error_code?: string | null;
          error_http?: number | null;
          id?: string;
          idempotency_key?: string;
          method?: string;
          network?: string;
          payee?: string;
          payer?: string;
          status?: string;
          tx_hash?: string | null;
        };
        Relationships: [];
      };
      jobs: {
        Row: {
          agent_slug: string;
          completed_at: string | null;
          created_at: string;
          error: string | null;
          id: string;
          input: Json | null;
          result: Json | null;
          status: string;
          updated_at: string;
          user_id: string | null;
        };
        Insert: {
          agent_slug: string;
          completed_at?: string | null;
          created_at?: string;
          error?: string | null;
          id?: string;
          input?: Json | null;
          result?: Json | null;
          status?: string;
          updated_at?: string;
          user_id?: string | null;
        };
        Update: {
          agent_slug?: string;
          completed_at?: string | null;
          created_at?: string;
          error?: string | null;
          id?: string;
          input?: Json | null;
          result?: Json | null;
          status?: string;
          updated_at?: string;
          user_id?: string | null;
        };
        Relationships: [];
      };
      key_batch_settlements: {
        Row: {
          call_count: number;
          confirmed_at: string | null;
          created_at: string | null;
          error: string | null;
          id: string;
          key_hash: string;
          key_id: string;
          status: string;
          total_usdc: number;
          tx_hash: string | null;
        };
        Insert: {
          call_count: number;
          confirmed_at?: string | null;
          created_at?: string | null;
          error?: string | null;
          id?: string;
          key_hash: string;
          key_id: string;
          status?: string;
          total_usdc: number;
          tx_hash?: string | null;
        };
        Update: {
          call_count?: number;
          confirmed_at?: string | null;
          created_at?: string | null;
          error?: string | null;
          id?: string;
          key_hash?: string;
          key_id?: string;
          status?: string;
          total_usdc?: number;
          tx_hash?: string | null;
        };
        Relationships: [];
      };
      kite_schema_transforms: {
        Row: {
          created_at: string | null;
          hit_count: number | null;
          id: string;
          owner_ref: string | null;
          schema_hash: string | null;
          source_agent_id: string;
          target_agent_id: string;
          transform_fn: string;
          transform_fn_sig: string | null;
          updated_at: string | null;
        };
        Insert: {
          created_at?: string | null;
          hit_count?: number | null;
          id?: string;
          owner_ref?: string | null;
          schema_hash?: string | null;
          source_agent_id: string;
          target_agent_id: string;
          transform_fn: string;
          transform_fn_sig?: string | null;
          updated_at?: string | null;
        };
        Update: {
          created_at?: string | null;
          hit_count?: number | null;
          id?: string;
          owner_ref?: string | null;
          schema_hash?: string | null;
          source_agent_id?: string;
          target_agent_id?: string;
          transform_fn?: string;
          transform_fn_sig?: string | null;
          updated_at?: string | null;
        };
        Relationships: [];
      };
      llm_response_cache: {
        Row: {
          agent_slug: string;
          cache_key: string;
          created_at: string | null;
          payload: Json;
          updated_at: string | null;
        };
        Insert: {
          agent_slug: string;
          cache_key: string;
          created_at?: string | null;
          payload: Json;
          updated_at?: string | null;
        };
        Update: {
          agent_slug?: string;
          cache_key?: string;
          created_at?: string | null;
          payload?: Json;
          updated_at?: string | null;
        };
        Relationships: [];
      };
      marketplace_contracts: {
        Row: {
          active: boolean | null;
          address: string;
          chain: string;
          chain_id: number;
          deployed_at: string | null;
          id: string;
          usdc_address: string;
        };
        Insert: {
          active?: boolean | null;
          address: string;
          chain: string;
          chain_id: number;
          deployed_at?: string | null;
          id?: string;
          usdc_address: string;
        };
        Update: {
          active?: boolean | null;
          address?: string;
          chain?: string;
          chain_id?: number;
          deployed_at?: string | null;
          id?: string;
          usdc_address?: string;
        };
        Relationships: [];
      };
      onboarding_sessions: {
        Row: {
          created_at: string;
          current_step: number;
          data: Json;
          expires_at: string;
          id: string;
          ip: string;
          status: string;
        };
        Insert: {
          created_at?: string;
          current_step?: number;
          data?: Json;
          expires_at?: string;
          id?: string;
          ip: string;
          status?: string;
        };
        Update: {
          created_at?: string;
          current_step?: number;
          data?: Json;
          expires_at?: string;
          id?: string;
          ip?: string;
          status?: string;
        };
        Relationships: [];
      };
      pending_recordings: {
        Row: {
          agent_call_id: string | null;
          amount_usdc: number;
          attempts: number;
          created_at: string;
          id: string;
          last_error: string | null;
          next_retry_at: string;
          payer_address: string;
          resolved_at: string | null;
          slug: string;
          tx_hash: string | null;
        };
        Insert: {
          agent_call_id?: string | null;
          amount_usdc: number;
          attempts?: number;
          created_at?: string;
          id?: string;
          last_error?: string | null;
          next_retry_at?: string;
          payer_address: string;
          resolved_at?: string | null;
          slug: string;
          tx_hash?: string | null;
        };
        Update: {
          agent_call_id?: string | null;
          amount_usdc?: number;
          attempts?: number;
          created_at?: string;
          id?: string;
          last_error?: string | null;
          next_retry_at?: string;
          payer_address?: string;
          resolved_at?: string | null;
          slug?: string;
          tx_hash?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'pending_recordings_agent_call_id_fkey';
            columns: ['agent_call_id'];
            isOneToOne: false;
            referencedRelation: 'agent_calls';
            referencedColumns: ['id'];
          },
        ];
      };
      pipeline_executions: {
        Row: {
          completed_at: string | null;
          created_at: string;
          error_detail: string | null;
          failed_at_step: number | null;
          id: string;
          key_id: string;
          receipt_signature: string | null;
          status: string;
          step_outputs: Json | null;
          steps_completed: number;
          steps_requested: number;
          total_cost_usdc: number;
        };
        Insert: {
          completed_at?: string | null;
          created_at?: string;
          error_detail?: string | null;
          failed_at_step?: number | null;
          id?: string;
          key_id: string;
          receipt_signature?: string | null;
          status: string;
          step_outputs?: Json | null;
          steps_completed?: number;
          steps_requested: number;
          total_cost_usdc?: number;
        };
        Update: {
          completed_at?: string | null;
          created_at?: string;
          error_detail?: string | null;
          failed_at_step?: number | null;
          id?: string;
          key_id?: string;
          receipt_signature?: string | null;
          status?: string;
          step_outputs?: Json | null;
          steps_completed?: number;
          steps_requested?: number;
          total_cost_usdc?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'pipeline_executions_key_id_fkey';
            columns: ['key_id'];
            isOneToOne: false;
            referencedRelation: 'agent_keys';
            referencedColumns: ['id'];
          },
        ];
      };
      profiles: {
        Row: {
          avatar_url: string | null;
          created_at: string;
          email: string;
          full_name: string | null;
          id: string;
          smart_account_address: string | null;
          updated_at: string;
          wallet_address: string | null;
        };
        Insert: {
          avatar_url?: string | null;
          created_at?: string;
          email: string;
          full_name?: string | null;
          id: string;
          smart_account_address?: string | null;
          updated_at?: string;
          wallet_address?: string | null;
        };
        Update: {
          avatar_url?: string | null;
          created_at?: string;
          email?: string;
          full_name?: string | null;
          id?: string;
          smart_account_address?: string | null;
          updated_at?: string;
          wallet_address?: string | null;
        };
        Relationships: [];
      };
      registries: {
        Row: {
          agent_endpoint: string | null;
          auth: Json | null;
          created_at: string;
          discovery_endpoint: string;
          enabled: boolean;
          id: string;
          invoke_endpoint: string;
          name: string;
          owner_ref: string;
          schema: Json;
        };
        Insert: {
          agent_endpoint?: string | null;
          auth?: Json | null;
          created_at?: string;
          discovery_endpoint: string;
          enabled?: boolean;
          id: string;
          invoke_endpoint: string;
          name: string;
          owner_ref?: string;
          schema: Json;
        };
        Update: {
          agent_endpoint?: string | null;
          auth?: Json | null;
          created_at?: string;
          discovery_endpoint?: string;
          enabled?: boolean;
          id?: string;
          invoke_endpoint?: string;
          name?: string;
          owner_ref?: string;
          schema?: Json;
        };
        Relationships: [];
      };
      sandbox_credits: {
        Row: {
          balance_usdc: number;
          created_at: string;
          total_granted: number;
          total_used: number;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          balance_usdc?: number;
          created_at?: string;
          total_granted?: number;
          total_used?: number;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          balance_usdc?: number;
          created_at?: string;
          total_granted?: number;
          total_used?: number;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      settlement_failures: {
        Row: {
          agent_call_id: string | null;
          agent_slug: string;
          amount_usdc: number;
          caller_wallet: string | null;
          created_at: string;
          error_reason: string | null;
          id: string;
          resolution_note: string | null;
          resolved_at: string | null;
          settlement_tx_hash: string;
        };
        Insert: {
          agent_call_id?: string | null;
          agent_slug: string;
          amount_usdc: number;
          caller_wallet?: string | null;
          created_at?: string;
          error_reason?: string | null;
          id?: string;
          resolution_note?: string | null;
          resolved_at?: string | null;
          settlement_tx_hash: string;
        };
        Update: {
          agent_call_id?: string | null;
          agent_slug?: string;
          amount_usdc?: number;
          caller_wallet?: string | null;
          created_at?: string;
          error_reason?: string | null;
          id?: string;
          resolution_note?: string | null;
          resolved_at?: string | null;
          settlement_tx_hash?: string;
        };
        Relationships: [];
      };
      system_config: {
        Row: {
          key: string;
          updated_at: string | null;
          value: string;
        };
        Insert: {
          key: string;
          updated_at?: string | null;
          value: string;
        };
        Update: {
          key?: string;
          updated_at?: string | null;
          value?: string;
        };
        Relationships: [];
      };
      tasks: {
        Row: {
          artifacts: Json;
          context_id: string | null;
          created_at: string;
          id: string;
          messages: Json;
          metadata: Json | null;
          owner_ref: string;
          status: string;
          updated_at: string;
        };
        Insert: {
          artifacts?: Json;
          context_id?: string | null;
          created_at?: string;
          id?: string;
          messages?: Json;
          metadata?: Json | null;
          owner_ref: string;
          status?: string;
          updated_at?: string;
        };
        Update: {
          artifacts?: Json;
          context_id?: string | null;
          created_at?: string;
          id?: string;
          messages?: Json;
          metadata?: Json | null;
          owner_ref?: string;
          status?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      token_catalog: {
        Row: {
          avalanche_address: string | null;
          coingecko_id: string;
          name: string;
          symbol: string;
          updated_at: string | null;
        };
        Insert: {
          avalanche_address?: string | null;
          coingecko_id: string;
          name: string;
          symbol: string;
          updated_at?: string | null;
        };
        Update: {
          avalanche_address?: string | null;
          coingecko_id?: string;
          name?: string;
          symbol?: string;
          updated_at?: string | null;
        };
        Relationships: [];
      };
      user_files: {
        Row: {
          cid: string;
          created_at: string;
          filename: string | null;
          id: string;
          mime_type: string | null;
          size_bytes: number | null;
          user_id: string;
        };
        Insert: {
          cid: string;
          created_at?: string;
          filename?: string | null;
          id?: string;
          mime_type?: string | null;
          size_bytes?: number | null;
          user_id: string;
        };
        Update: {
          cid?: string;
          created_at?: string;
          filename?: string | null;
          id?: string;
          mime_type?: string | null;
          size_bytes?: number | null;
          user_id?: string;
        };
        Relationships: [];
      };
      webhook_deliveries: {
        Row: {
          attempt: number;
          delivered_at: string | null;
          error_message: string | null;
          event: string;
          id: string;
          locked_until: string | null;
          payload: Json;
          status_code: number | null;
          success: boolean;
          webhook_id: string;
        };
        Insert: {
          attempt?: number;
          delivered_at?: string | null;
          error_message?: string | null;
          event: string;
          id?: string;
          locked_until?: string | null;
          payload: Json;
          status_code?: number | null;
          success?: boolean;
          webhook_id: string;
        };
        Update: {
          attempt?: number;
          delivered_at?: string | null;
          error_message?: string | null;
          event?: string;
          id?: string;
          locked_until?: string | null;
          payload?: Json;
          status_code?: number | null;
          success?: boolean;
          webhook_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'webhook_deliveries_webhook_id_fkey';
            columns: ['webhook_id'];
            isOneToOne: false;
            referencedRelation: 'webhooks';
            referencedColumns: ['id'];
          },
        ];
      };
      webhooks: {
        Row: {
          created_at: string;
          events: string[];
          id: string;
          is_active: boolean;
          secret: string;
          updated_at: string;
          url: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          events?: string[];
          id?: string;
          is_active?: boolean;
          secret: string;
          updated_at?: string;
          url: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          events?: string[];
          id?: string;
          is_active?: boolean;
          secret?: string;
          updated_at?: string;
          url?: string;
          user_id?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      creator_pending_earnings: {
        Row: {
          creator_id: string | null;
          creator_share: number | null;
          last_call_at: string | null;
          platform_share: number | null;
          total_calls: number | null;
          total_earned: number | null;
          username: string | null;
          wallet_address: string | null;
        };
        Relationships: [];
      };
    };
    Functions: {
      claim_agent_link: {
        Args: { p_token_hash: string };
        Returns: {
          id: string;
          owner_ref: string;
          key_id: string;
          slug: string;
          registry: string | null;
          max_price_usdc: number;
          chain_id: number;
        }[];
      };
      settle_agent_link: {
        Args: {
          p_id: string;
          p_owner_ref: string;
          p_outcome: string;
          p_tx_hash: string | null;
          p_cost: number | null;
          p_error: string | null;
        };
        Returns: undefined;
      };
      accumulate_payment_voucher: {
        Args: {
          p_intent_id: string;
          p_owner_ref: string;
          p_voucher_id: string;
          p_amount: number;
        };
        Returns: { consumed: number; is_duplicate: boolean }[];
      };
      capture_debit_signature: {
        Args: {
          p_intent_id: string;
          p_owner_ref: string;
          p_key_id: string;
          p_key_id_hash: string;
          // NUMERIC(78,0) uint256 → string (evita pérdida de precisión > 2^53).
          p_amount_atomic: string;
          p_deadline: number;
          p_nonce: string;
          p_signature: string;
          p_recovered: string | null;
          p_status: string;
          p_reason: string | null;
        };
        Returns: {
          persisted_status: string;
          persisted_reason: string | null;
        }[];
      };
      record_debit_hop1: {
        Args: {
          p_intent_id: string;
          p_owner_ref: string;
          p_key_id: string;
          // NUMERIC uint256 → string (evita pérdida de precisión > 2^53).
          p_nonce: string;
          p_tx_hash: string;
        };
        Returns: {
          persisted_tx_hash: string | null;
        }[];
      };
      record_debit_settle_status: {
        Args: {
          p_intent_id: string;
          p_owner_ref: string;
          p_key_id: string;
          // NUMERIC uint256 → string (evita pérdida de precisión > 2^53).
          p_nonce: string;
          p_status: string;
        };
        Returns: undefined;
      };
      close_payment_intent_for_settle: {
        Args: {
          p_intent_id: string;
          p_owner_ref: string;
          p_reported_usage: number;
        };
        Returns: {
          final_amount: number;
          prev_status: string;
          intent_type: string;
          key_id: string;
          chain_id: number;
          pay_to: string;
          authorized_usd: number;
          consumed_usd: number;
          settle_tx_hash: string | null;
          settle_outcome: string | null;
        }[];
      };
      record_settle_outcome: {
        Args: {
          p_intent_id: string;
          p_owner_ref: string;
          p_outcome: string;
          p_tx_hash: string | null;
          p_residual: number | null;
          p_error: string | null;
        };
        Returns: undefined;
      };
      finalize_payment_intent: {
        Args: {
          p_intent_id: string;
          p_owner_ref: string;
          p_tx_hash: string | null;
          p_final_amount: number;
          p_residual: number | null;
          p_outcome: string;
          p_error: string | null;
        };
        Returns: undefined;
      };
      open_payment_intent: {
        Args: {
          p_id: string;
          p_intent_type: string;
          p_owner_ref: string;
          p_key_id: string;
          p_buyer_wallet: string | null;
          p_seller_ref: string;
          p_pay_to: string;
          p_chain_id: number;
          p_authorized_usd: number;
          p_cap_signature: string | null;
          p_cap_nonce: string | null;
          p_expires_at: string;
        };
        Returns: undefined;
      };
      open_dispute: {
        Args: {
          p_intent_id: string;
          p_owner_ref: string;
        };
        Returns: {
          intent_type: string;
          key_id: string;
          chain_id: number;
          pay_to: string;
          seller_ref: string;
          authorized_usd: number;
          consumed_usd: number;
          expires_at: string;
        }[];
      };
      close_payment_intent_for_arbitration: {
        Args: {
          p_intent_id: string;
          p_owner_ref: string;
          p_arb_amount: number;
        };
        Returns: {
          final_amount: number;
          prev_status: string;
          intent_type: string;
          key_id: string;
          chain_id: number;
          pay_to: string;
          authorized_usd: number;
          consumed_usd: number;
          settle_tx_hash: string | null;
          settle_outcome: string | null;
        }[];
      };
      append_step_output: {
        Args: {
          p_agent_slug: string;
          p_output: string;
          p_pipeline_id: string;
          p_step: number;
        };
        Returns: undefined;
      };
      check_and_deduct_budget: {
        Args: { p_amount: number; p_key_id: string };
        Returns: boolean;
      };
      claim_refund_outbox: {
        Args: { p_limit: number };
        Returns: {
          amount_usd: number;
          attempts: number;
          chain_id: number;
          created_at: string;
          destination: string | null;
          id: string;
          key_id: string;
          last_error: string | null;
          owner_ref: string;
          reason: string;
          status: string;
          updated_at: string;
        }[];
        SetofOptions: {
          from: '*';
          to: 'a2a_refund_outbox';
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      debit_delegation_and_parent: {
        Args: {
          p_amount_usd: number;
          p_chain_id: number;
          p_delegation_id: string;
          p_destination?: string;
          p_key_id: string;
          p_owner_ref: string;
        };
        Returns: number;
      };
      debit_session_and_parent: {
        Args: {
          p_amount_usd: number;
          p_chain_id: number;
          p_destination?: string;
          p_key_id: string;
          p_owner_ref: string;
          p_session_id: string;
        };
        Returns: number;
      };
      debit_with_dest_policy: {
        Args: {
          p_amount_usd: number;
          p_chain_id: number;
          p_destination: string;
          p_key_id: string;
          p_owner_ref: string;
        };
        Returns: undefined;
      };
      deduct_key_balance: {
        Args: { p_amount: number; p_key_id: string };
        Returns: boolean;
      };
      deduct_sandbox_balance: {
        Args: { p_amount: number; p_user_id: string };
        Returns: boolean;
      };
      discover_agents_v2: {
        Args: { p_category?: string; p_limit?: number; p_max_price?: number };
        Returns: {
          agent_type: string;
          capabilities: Json;
          category: string;
          chain: string;
          cover_image: string;
          created_at: string;
          creator_wallet: string;
          currency: string;
          description: string;
          error_rate_7d: number;
          error_rate_sample_size: number;
          id: string;
          input_schema: Json;
          is_featured: boolean;
          name: string;
          on_chain_registered: boolean;
          output_schema: Json;
          p50_latency_ms: number;
          p95_latency_ms: number;
          price_per_call: number;
          registration_type: string;
          slug: string;
          status: string;
          total_calls: number;
          updated_at: string;
        }[];
      };
      get_agent_analytics: {
        Args: never;
        Returns: {
          agent_calls_count: number;
          agent_type: string;
          avg_latency_ms: number;
          calls_24h: number;
          calls_7d: number;
          category: string;
          creator_id: string;
          erc8004_id: string;
          human_calls_count: number;
          id: string;
          name: string;
          on_chain_registered: boolean;
          price_per_call: number;
          reputation_score: number;
          revenue_24h: number;
          slug: string;
          total_calls: number;
          total_revenue: number;
        }[];
      };
      get_agent_percentile_metrics: {
        Args: { p_agent_id: string };
        Returns: {
          error_rate_7d: number;
          error_rate_sample: number;
          p50_latency_ms: number;
          p95_latency_ms: number;
        }[];
      };
      get_pipeline_for_retry: {
        Args: { p_key_hash: string; p_pipeline_id: string };
        Returns: {
          id: string;
          owned_by_key: boolean;
          status: string;
          step_outputs: Json;
        }[];
      };
      get_trending_agents: {
        Args: { days?: number; limit_count?: number };
        Returns: {
          agent_type: string;
          capabilities: Json | null;
          category: string;
          chain: string;
          chain_registered_at: string | null;
          consecutive_failures: number;
          cover_image: string | null;
          created_at: string | null;
          creator_id: string | null;
          creator_price: number | null;
          creator_wallet: string | null;
          currency: string;
          dependencies: string[] | null;
          description: string | null;
          endpoint_url: string | null;
          erc8004_id: number | null;
          free_trial_enabled: boolean;
          free_trial_limit: number;
          health_check: Json | null;
          id: string;
          input_schema: Json | null;
          is_featured: boolean | null;
          is_verified: boolean;
          last_checked_at: string | null;
          long_running: boolean;
          marketplace_address: string | null;
          max_rpd: number;
          max_rpm: number;
          mcp_description: string | null;
          mcp_tool_name: string | null;
          metadata: Json | null;
          name: string;
          on_chain_registered: boolean | null;
          output_schema: Json | null;
          performance_score: number | null;
          price_per_call: number;
          registration_type:
            | Database['public']['Enums']['registration_type']
            | null;
          reputation_count: number | null;
          reputation_score: number | null;
          sandbox_enabled: boolean;
          search_vector: unknown;
          slug: string;
          status: string;
          tags: string[] | null;
          token_id: number | null;
          total_calls: number | null;
          total_revenue: number | null;
          updated_at: string | null;
          webhook_secret: string;
        }[];
        SetofOptions: {
          from: '*';
          to: 'agents';
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      increment_a2a_key_spend: {
        Args: {
          p_amount_usd: number;
          p_chain_id: number;
          p_key_id: string;
          p_owner_ref: string;
        };
        Returns: undefined;
      };
      increment_agent_key_spend: {
        Args: { p_amount: number; p_key_id: string };
        Returns: undefined;
      };
      increment_agent_stats: {
        Args: { p_agent_id: string; p_amount: number };
        Returns: undefined;
      };
      increment_key_budget: {
        Args: { p_amount: number; p_key_id: string; p_owner_id: string };
        Returns: undefined;
      };
      increment_pending_earnings: {
        Args: { p_amount: number; p_user_id: string };
        Returns: undefined;
      };
      insert_agent_example: {
        Args: {
          p_agent_id: string;
          p_creator_id: string;
          p_input: string;
          p_label: string;
          p_output: string;
        };
        Returns: {
          agent_id: string;
          created_at: string;
          creator_id: string;
          id: string;
          input: string;
          label: string | null;
          output: string;
          sort_order: number;
          updated_at: string;
        };
        SetofOptions: {
          from: '*';
          to: 'agent_examples';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      insert_receipt: {
        Args: {
          p_agent_key_id: string;
          p_amount_usd: number;
          p_chain_id: number;
          p_counterparty: string;
          p_delegation_id: string;
          p_orchestration_id: string;
          p_owner_ref: string;
          p_receipt_type: string;
          p_session_id: string;
          p_tx_hash: string;
        };
        Returns: {
          created_at: string;
          id: string;
          prev_receipt_hash: string;
        }[];
      };
      refund_a2a_key_spend: {
        Args: {
          p_amount_usd: number;
          p_chain_id: number;
          p_key_id: string;
          p_owner_ref: string;
        };
        Returns: number;
      };
      refund_delegation_and_parent: {
        Args: {
          p_amount_usd: number;
          p_chain_id: number;
          p_delegation_id: string;
          p_destination?: string;
          p_key_id: string;
          p_owner_ref: string;
        };
        Returns: number;
      };
      refund_session_and_parent: {
        Args: {
          p_amount_usd: number;
          p_chain_id: number;
          p_destination?: string;
          p_key_id: string;
          p_owner_ref: string;
          p_session_id: string;
        };
        Returns: number;
      };
      refund_key_balance: {
        Args: {
          p_amount: number;
          p_expected_user_id?: string;
          p_key_id: string;
        };
        Returns: boolean;
      };
      refund_sandbox_balance: {
        Args: { p_amount: number; p_user_id: string };
        Returns: undefined;
      };
      refund_with_dest_policy: {
        Args: {
          p_amount_usd: number;
          p_chain_id: number;
          p_destination: string;
          p_key_id: string;
          p_owner_ref: string;
        };
        Returns: number;
      };
      register_a2a_key_deposit: {
        Args: {
          p_amount_usd: number;
          p_chain_id: number;
          p_key_id: string;
          p_owner_ref: string;
          p_token?: string;
          p_tx_hash: string;
        };
        Returns: string;
      };
      search_agents: {
        Args: {
          filter_agent_type?: string;
          filter_category?: string;
          result_limit?: number;
          result_offset?: number;
          search_query: string;
        };
        Returns: {
          agent_type: string;
          category: string;
          description: string;
          id: string;
          is_featured: boolean;
          name: string;
          price_per_call: number;
          rank: number;
          slug: string;
          total_calls: number;
        }[];
      };
      sync_key_after_settlement: {
        Args: { p_call_ids: string[]; p_key_id: string; p_new_budget: number };
        Returns: undefined;
      };
      use_trial: {
        Args: { p_agent_id: string; p_limit: number; p_user_id: string };
        Returns: number;
      };
    };
    Enums: {
      account_status_enum: 'active' | 'pending_review' | 'suspended';
      registration_type: 'off_chain' | 'on_chain';
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>;

type DefaultSchema = DatabaseWithoutInternals[Extract<
  keyof Database,
  'public'
>];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema['Tables'] &
        DefaultSchema['Views'])
    ? (DefaultSchema['Tables'] &
        DefaultSchema['Views'])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema['Tables']
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema['Tables']
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema['Enums']
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums']
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums'][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema['Enums']
    ? DefaultSchema['Enums'][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema['CompositeTypes']
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes']
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes'][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema['CompositeTypes']
    ? DefaultSchema['CompositeTypes'][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {
      account_status_enum: ['active', 'pending_review', 'suspended'],
      registration_type: ['off_chain', 'on_chain'],
    },
  },
} as const;

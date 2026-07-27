import { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
    return knex.schema.alterTable("agent", (table) => {
        table.string("auth_mode", 16).notNullable().defaultTo("password");
        // The central instance must retain the client credential to reconnect.
        // Agent.toJSON intentionally never exposes this raw value.
        table.text("token").nullable();
    });
}

export async function down(knex: Knex): Promise<void> {
    return knex.schema.alterTable("agent", (table) => {
        table.dropColumn("token");
        table.dropColumn("auth_mode");
    });
}
